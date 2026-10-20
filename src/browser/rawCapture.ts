/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rawCapture.ts: The raw audio recorder PrismCast installs in the capture extension's page, for streams whose video FFmpeg grabs from the screen.
 *
 * The default recorder is the extension's own START_RECORDING: Chrome's MediaRecorder encodes the tab's video and audio and the chunks travel the WebSocket to
 * FFmpeg, which only remuxes them. In the FFmpeg encoder mode the video never passes through Chrome's encoder or the socket at all - FFmpeg grabs it straight off
 * the stream's own window on the X display (browser/captureWindows.ts) - so the tab capture is asked for audio alone, and this recorder hands that audio over
 * unencoded: each block is copied out through MediaStreamTrackProcessor as 32-bit float PCM and sent as one self-delimiting message, which
 * streaming/rawPump.ts paces into FFmpeg's audio pipe. At 48 kHz stereo that is under half a megabyte a second.
 *
 * Everything else about a capture stays as it is: the attempt, the socket index, the activeTab grant, the tab selection, and the stop protocol in tabCapture.ts
 * all apply unchanged, because this recorder connects back to the same WebSocket server under the same index scheme and answers the same rejections Chrome gives
 * START_RECORDING.
 *
 * The two page functions below run inside the extension's options page through page.evaluate, which serializes their source. They therefore reference nothing
 * from this module: every value they need arrives in the settings object.
 *
 * Message layout, little-endian, RAW_HEADER_SIZE bytes of header followed by the payload:
 *
 *   0  uint32   total message length, header included
 *   4  uint8    kind: RAW_KIND_AUDIO
 *   5  uint8    channel count
 *   6  uint16   reserved, zero
 *   8  float64  timestamp in microseconds, Chrome's capture clock for the track
 *   16 uint32   sample rate
 *   20 uint32   frames per channel
 *
 * The payload is 32-bit float planar, one plane per channel.
 */

// Constants.

// The header that precedes every raw message.
export const RAW_HEADER_SIZE = 24;

// The message kind for a block of audio. Kind 1 is reserved: an earlier revision of the protocol carried video under it.
export const RAW_KIND_AUDIO = 2;

// How far the extension's socket may back up before the recorder drops audio at the source. A live capture cannot wait for a slow reader, and a dropped block
// is one the pump fills with silence, which keeps the timeline intact. About twenty seconds of 48 kHz stereo.
export const RAW_CAPTURE_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// Types.

/**
 * The settings object startRawRecording receives. It carries every value the page function needs, since a serialized function can close over nothing.
 */
export interface RawRecordingSettings {

  readonly audioKind: number;
  readonly headerSize: number;
  readonly index: number;
  readonly maxBufferedBytes: number;
}

// The handle the page keeps for each running raw recording, keyed by socket index, so the stop function can find it.
interface RawRecorderHandle {

  stop: () => void;
}

// The page-side surface of the extension: the capture API and its error channel. Declared here rather than globally because only the page functions below see it.
interface ExtensionChromeApi {

  readonly runtime: { readonly lastError?: { readonly message?: string } };
  readonly tabCapture: {

    capture: (options: { audio: boolean; video: boolean }, callback: (stream: MediaStream | null) => void) => void;
  };
}

// MediaStreamTrackProcessor is Chrome's, not the DOM library's, so the page functions describe the slice of it they use.
interface TrackProcessor<T> {

  readonly readable: ReadableStream<T>;
}

type TrackProcessorConstructor = new <T>(init: { track: MediaStreamTrack }) => TrackProcessor<T>;

// The globals the page functions reach for, typed once.
interface RawRecorderGlobals {

  __prismcastRawRecorders?: Record<number, RawRecorderHandle>;
  chrome?: ExtensionChromeApi;
  MediaStreamTrackProcessor?: TrackProcessorConstructor;
}

// Page functions.

/**
 * Starts a raw audio recording in the extension's options page. Runs in the page, never in Node: tabCapture.ts hands it to extension.evaluate.
 *
 * The order mirrors START_RECORDING, which the server-side attempt depends on: the socket connects first, under this capture's index, and only then is Chrome
 * asked for the capture, so a start Chrome refuses still leaves a connected socket for the attempt to discard. A refusal rejects with Chrome's own message as a
 * bare string, exactly as START_RECORDING does, so the grant-pending poll and the refusal diagnostics read it the same way.
 * @param settings - The socket index and the protocol values to frame the audio with.
 * @returns A promise that settles once the capture is running and its pump has started.
 */
export async function startRawRecording(settings: RawRecordingSettings): Promise<void> {

  const globals = globalThis as unknown as RawRecorderGlobals;
  const recorders = (globals.__prismcastRawRecorders ??= {});
  const chromeApi = globals.chrome;
  const Processor = globals.MediaStreamTrackProcessor;

  if(!chromeApi || !Processor) {

    throw new Error("Raw capture needs chrome.tabCapture and MediaStreamTrackProcessor in the extension page.");
  }

  const socket = new WebSocket("ws://localhost:" + window.location.hash.substring(1) + "/?index=" + String(settings.index));

  socket.binaryType = "arraybuffer";

  await new Promise<void>((resolve) => {

    if(socket.readyState === WebSocket.OPEN) {

      resolve();

      return;
    }

    socket.addEventListener("open", () => resolve());
  });

  const stream = await new Promise<MediaStream>((resolve, reject) => {

    chromeApi.tabCapture.capture({ audio: true, video: false }, (captured) => {

      const lastError = chromeApi.runtime.lastError;

      if(lastError || !captured) {

        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- START_RECORDING rejects with Chrome's bare message and callers match on it.
        reject(lastError?.message);

        return;
      }

      resolve(captured);
    });
  });

  const pumpAudio = async (track: MediaStreamTrack): Promise<void> => {

    const reader = new Processor<AudioData>({ track }).readable.getReader();

    for(;;) {

      // eslint-disable-next-line no-await-in-loop -- Audio blocks are read one at a time by design.
      const { done, value: data } = await reader.read();

      if(done) {

        return;
      }

      try {

        // A backed-up socket means the reader is behind. Dropping here costs nothing and the pump fills the gap with silence.
        if((socket.readyState !== WebSocket.OPEN) || (socket.bufferedAmount > settings.maxBufferedBytes)) {

          continue;
        }

        const channels = data.numberOfChannels;
        const frames = data.numberOfFrames;
        const buffer = new ArrayBuffer(settings.headerSize + (channels * frames * 4));
        const view = new DataView(buffer);

        for(let plane = 0; plane < channels; plane++) {

          data.copyTo(new Float32Array(buffer, settings.headerSize + (plane * frames * 4), frames), { format: "f32-planar", planeIndex: plane });
        }

        view.setUint32(0, buffer.byteLength, true);
        view.setUint8(4, settings.audioKind);
        view.setUint8(5, channels);
        view.setUint16(6, 0, true);
        view.setFloat64(8, data.timestamp, true);
        view.setUint32(16, data.sampleRate, true);
        view.setUint32(20, frames, true);
        socket.send(buffer);
      } finally {

        data.close();
      }
    }
  };

  const tracks = stream.getTracks();

  recorders[settings.index] = {

    stop: (): void => {

      for(const track of tracks) {

        track.stop();
      }
    }
  };

  /* Once the track has ended - stopped by the stop function, or ended by Chrome when the tab went away - the socket closes. Messages already queued on it are
   * still delivered ahead of the close, which is the completion signal the server-side attempt waits on, the same one START_RECORDING gives.
   */
  void Promise.allSettled(tracks.map(pumpAudio)).then(() => {

    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- The registry is keyed by socket index.
    delete recorders[settings.index];
    socket.close();
  });
}

/**
 * Stops the raw recording published under a socket index. Runs in the extension's options page. A recording that is already gone is not an error.
 * @param index - The socket index the recording was started under.
 */
export function stopRawRecording(index: number): void {

  (globalThis as unknown as RawRecorderGlobals).__prismcastRawRecorders?.[index]?.stop();
}

/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rawCapture.ts: The raw-frame recorder PrismCast installs in the capture extension's page, for streams whose video FFmpeg encodes.
 *
 * The default recorder is the extension's own START_RECORDING: Chrome's MediaRecorder encodes the tab and the chunks travel the WebSocket to FFmpeg, which only
 * remuxes them. On hosts whose GPU Chrome cannot encode with (NVIDIA on Linux, where Chrome's hardware encoders are VA-API only), that encode is the largest
 * share of a stream's CPU. This recorder takes the same chrome.tabCapture stream and hands its frames to FFmpeg unencoded instead: each video frame and each
 * block of audio is copied out through MediaStreamTrackProcessor and sent as one self-delimiting message, and streaming/rawPump.ts paces them into the pipes of
 * an FFmpeg that does the encoding.
 *
 * Everything else about a capture stays as it is: the attempt, the socket index, the activeTab grant, the tab selection, and the stop protocol in tabCapture.ts
 * all apply unchanged, because this recorder connects back to the same WebSocket server under the same index scheme and answers the same rejections Chrome gives
 * START_RECORDING. Both tracks come from one MediaStream, so their timestamps share Chrome's capture clock, and that is what keeps audio and video in step.
 *
 * The two page functions below run inside the extension's options page through page.evaluate, which serializes their source. They therefore reference nothing
 * from this module: every value they need arrives in the settings object.
 *
 * Message layout, little-endian, RAW_HEADER_SIZE bytes of header followed by the payload:
 *
 *   0  uint32   total message length, header included
 *   4  uint8    kind: RAW_KIND_VIDEO or RAW_KIND_AUDIO
 *   5  uint8    video: pixel format code (RAW_PIXEL_FORMATS); audio: channel count
 *   6  uint16   reserved, zero
 *   8  float64  timestamp in microseconds, Chrome's capture clock
 *   16 uint32   video: width; audio: sample rate
 *   20 uint32   video: height; audio: frames per channel
 *
 * Video payloads are the frame's visible rectangle in its native layout, planes packed back to back with no row padding. Audio payloads are 32-bit float planar,
 * one plane per channel.
 */

// Constants.

// The header that precedes every raw message.
export const RAW_HEADER_SIZE = 24;

// The message kinds.
export const RAW_KIND_VIDEO = 1;
export const RAW_KIND_AUDIO = 2;

// The pixel formats a video message can carry, by the code the header holds. The names are WebCodecs' VideoPixelFormat names. Code 0 is never sent.
export const RAW_PIXEL_FORMATS: Readonly<Record<string, number>> = { BGRA: 5, BGRX: 6, I420: 1, I420A: 7, NV12: 2, RGBA: 3, RGBX: 4 };

// How far the extension's socket may back up before the recorder drops video frames at the source. A live capture cannot wait for a slow reader, and a dropped
// frame here is one the pump fills by repeating its neighbor, which keeps the timeline intact. About a second of 720p video.
export const RAW_CAPTURE_MAX_BUFFERED_BYTES = 48 * 1024 * 1024;

// Types.

/**
 * The settings object startRawRecording receives. It carries every value the page function needs, since a serialized function can close over nothing.
 */
export interface RawRecordingSettings {

  readonly audio: boolean;
  readonly formatCodes: Readonly<Record<string, number>>;
  readonly headerSize: number;
  readonly index: number;
  readonly kinds: { readonly audio: number; readonly video: number };
  readonly maxBufferedBytes: number;
  readonly video: boolean;
  readonly videoConstraints?: unknown;
}

// The handle the page keeps for each running raw recording, keyed by socket index, so the stop function can find it.
interface RawRecorderHandle {

  stop: () => void;
}

// The page-side surface of the extension: the capture API and its error channel. Declared here rather than globally because only the page functions below see it.
interface ExtensionChromeApi {

  readonly runtime: { readonly lastError?: { readonly message?: string } };
  readonly tabCapture: {

    capture: (options: { audio: boolean; video: boolean; videoConstraints?: unknown }, callback: (stream: MediaStream | null) => void) => void;
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
 * Starts a raw recording in the extension's options page. Runs in the page, never in Node: tabCapture.ts hands it to extension.evaluate.
 *
 * The order mirrors START_RECORDING, which the server-side attempt depends on: the socket connects first, under this capture's index, and only then is Chrome
 * asked for the capture, so a start Chrome refuses still leaves a connected socket for the attempt to discard. A refusal rejects with Chrome's own message as a
 * bare string, exactly as START_RECORDING does, so the grant-pending poll and the refusal diagnostics read it the same way.
 * @param settings - What to capture and the protocol values to frame it with.
 * @returns A promise that settles once the capture is running and its pumps have started.
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

    chromeApi.tabCapture.capture({ audio: settings.audio, video: settings.video, videoConstraints: settings.videoConstraints }, (captured) => {

      const lastError = chromeApi.runtime.lastError;

      if(lastError || !captured) {

        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- START_RECORDING rejects with Chrome's bare message and callers match on it.
        reject(lastError?.message);

        return;
      }

      resolve(captured);
    });
  });

  // Writes the shared header fields into the front of a message.
  const writeHeader = (buffer: ArrayBuffer, kind: number, detail: number, timestamp: number, first: number, second: number): void => {

    const view = new DataView(buffer);

    view.setUint32(0, buffer.byteLength, true);
    view.setUint8(4, kind);
    view.setUint8(5, detail);
    view.setUint16(6, 0, true);
    view.setFloat64(8, timestamp, true);
    view.setUint32(16, first, true);
    view.setUint32(20, second, true);
  };

  const send = (buffer: ArrayBuffer): void => {

    if(socket.readyState === WebSocket.OPEN) {

      socket.send(buffer);
    }
  };

  const pumpVideo = async (track: MediaStreamTrack): Promise<void> => {

    const reader = new Processor<VideoFrame>({ track }).readable.getReader();

    for(;;) {

      // eslint-disable-next-line no-await-in-loop -- Frames are read one at a time by design.
      const { done, value: frame } = await reader.read();

      if(done) {

        return;
      }

      try {

        // A backed-up socket means the reader is behind. Dropping here, before the copy, costs nothing and the pump repeats the previous frame in its place.
        if(socket.bufferedAmount > settings.maxBufferedBytes) {

          continue;
        }

        const rect = frame.visibleRect ?? undefined;

        // A GPU-backed frame can report no format. Asking for RGBX converts it during the copy, and the pump knows how to take RGB.
        const format = frame.format ?? "RGBX";
        const copyOptions = (frame.format ? { rect } : { format, rect }) as VideoFrameCopyToOptions;
        const size = frame.allocationSize(copyOptions);
        const buffer = new ArrayBuffer(settings.headerSize + size);

        // eslint-disable-next-line no-await-in-loop -- The copy has to land before the frame is closed and the message sent.
        await frame.copyTo(new Uint8Array(buffer, settings.headerSize), copyOptions);

        writeHeader(buffer, settings.kinds.video, settings.formatCodes[format] ?? 0, frame.timestamp, rect?.width ?? frame.displayWidth,
          rect?.height ?? frame.displayHeight);
        send(buffer);
      } finally {

        frame.close();
      }
    }
  };

  const pumpAudio = async (track: MediaStreamTrack): Promise<void> => {

    const reader = new Processor<AudioData>({ track }).readable.getReader();

    for(;;) {

      // eslint-disable-next-line no-await-in-loop -- Audio blocks are read one at a time by design.
      const { done, value: data } = await reader.read();

      if(done) {

        return;
      }

      try {

        const channels = data.numberOfChannels;
        const frames = data.numberOfFrames;
        const buffer = new ArrayBuffer(settings.headerSize + (channels * frames * 4));

        for(let plane = 0; plane < channels; plane++) {

          data.copyTo(new Float32Array(buffer, settings.headerSize + (plane * frames * 4), frames), { format: "f32-planar", planeIndex: plane });
        }

        writeHeader(buffer, settings.kinds.audio, channels, data.timestamp, data.sampleRate, frames);
        send(buffer);
      } finally {

        data.close();
      }
    }
  };

  const tracks = stream.getTracks();
  const pumps = tracks.map((track) => ((track.kind === "video") ? pumpVideo(track) : pumpAudio(track)));

  recorders[settings.index] = {

    stop: (): void => {

      for(const track of tracks) {

        track.stop();
      }
    }
  };

  /* Once every track has ended - stopped by the stop function, or ended by Chrome when the tab went away - the socket closes. Messages already queued on it are
   * still delivered ahead of the close, which is the completion signal the server-side attempt waits on, the same one START_RECORDING gives.
   */
  void Promise.allSettled(pumps).then(() => {

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

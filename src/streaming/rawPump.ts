/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rawPump.ts: Paces raw capture messages into the two input pipes of an FFmpeg that encodes them.
 *
 * The raw recorder (browser/rawCapture.ts) sends each video frame and each block of audio as it arrives, stamped with Chrome's capture clock. FFmpeg reading raw
 * video and raw audio from pipes has no timestamps at all: it counts frames and samples. So the pump's job is to turn timestamped, irregular arrivals into two
 * perfectly regular streams that start together:
 *
 * - Video becomes exactly frameRate frames per second of yuv420p at the stream's size. A frame lands in the output slot its timestamp names; a slot no frame
 *   reached is filled by repeating the previous frame, and a frame that arrives for a slot already written is not written (it still becomes the frame the next
 *   repeat uses).
 * - Audio becomes continuous 48 kHz stereo 32-bit float. A block lands at the sample its timestamp names; a small disagreement is absorbed as jitter, a gap is
 *   filled with silence, and an overlap is trimmed.
 *
 * Both are measured from one shared origin, the first video frame's timestamp. Audio that arrives before it is dropped, and audio that starts after it is preceded
 * by silence, so the two pipes start in step and stay in step for as long as Chrome's clock does. When nothing at all arrives from either stream for longer than
 * RAW_MAX_GAP_US - the tab stalled, rather than jitter or one quiet track - the origin moves past the gap for both streams at once instead of the pipes being
 * filled with seconds of repeats and silence. A gap in one stream while the other flows is filled, because that one is real time passing.
 */
import { RAW_HEADER_SIZE, RAW_KIND_AUDIO, RAW_KIND_VIDEO, RAW_PIXEL_FORMATS } from "../browser/rawCapture.ts";
import { LOG } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";
import { Writable } from "node:stream";

// Constants.

// The audio the pump writes: what FFmpeg is told to read on the audio pipe.
export const RAW_AUDIO_SAMPLE_RATE = 48000;
export const RAW_AUDIO_CHANNELS = 2;

// Capture timestamps are in microseconds.
const MICROSECONDS_PER_SECOND = 1000000;

// A gap in either stream longer than this is a stall rather than jitter: the shared origin moves instead of the gap being filled.
export const RAW_MAX_GAP_US = 2000000;

// The audio disagreement absorbed as jitter rather than corrected, in samples: 20ms.
export const RAW_AUDIO_TOLERANCE_SAMPLES = 960;

// How much unwritten video the pump lets the FFmpeg pipe hold before it declares the encoder too slow and fails the stream. About three seconds of 720p.
export const RAW_PUMP_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;

// The largest message the parser accepts. A 4K RGBA frame is about 33MB, so anything larger is broken framing.
const RAW_MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

// The format names by header code.
const FORMAT_NAMES: ReadonlyMap<number, string> = new Map(Object.entries(RAW_PIXEL_FORMATS).map(([ name, code ]) => [ code, name ]));

// Types.

/**
 * One raw video frame as the recorder sent it.
 */
export interface RawVideoMessage {

  readonly data: Buffer;
  readonly format: string;
  readonly height: number;
  readonly kind: "video";
  readonly timestamp: number;
  readonly width: number;
}

/**
 * One block of raw audio as the recorder sent it: planar 32-bit float, one plane per channel.
 */
export interface RawAudioMessage {

  readonly channels: number;
  readonly data: Buffer;
  readonly frames: number;
  readonly kind: "audio";
  readonly sampleRate: number;
  readonly timestamp: number;
}

export type RawMessage = RawAudioMessage | RawVideoMessage;

/**
 * Streaming parser for the recorder's self-delimiting messages.
 */
export interface RawMessageParser {

  // Push a chunk of the capture stream. Throws when the framing is broken, since the framing is ours and there is nothing to resync to.
  push: (chunk: Buffer) => void;
}

/**
 * The origin both pacers measure from - the first video frame's capture timestamp, moved forward by stalls - and the latest timestamp either stream has shown.
 */
export interface RawTimeline {

  latestUs: Nullable<number>;
  originUs: Nullable<number>;
}

/**
 * Where one video frame goes: how many times to repeat the previous frame first, and whether this frame itself is written.
 */
export interface VideoPlacement {

  readonly emit: boolean;
  readonly repeats: number;
}

/**
 * The counts a pump keeps for its stream's diagnostics.
 */
export interface RawPumpStats {

  audioSamplesPadded: number;
  audioSamplesTrimmed: number;
  framesDropped: number;
  framesRejected: number;
  framesRepeated: number;
  framesWritten: number;
  stalls: number;
}

/**
 * What a pump is built with: the output geometry and rate FFmpeg was told to expect, and the two pipes to write.
 */
export interface RawPumpOptions {

  readonly audioOut: Writable;
  readonly frameRate: number;
  readonly height: number;
  readonly maxBufferedBytes?: number;
  readonly videoOut: Writable;
  readonly width: number;
}

/**
 * A pump: the writable the capture stream is piped into, with the counts it has kept.
 */
export interface RawPump extends Writable {

  readonly stats: RawPumpStats;
}

// Parsing.

/**
 * Creates a parser for the raw capture stream. The stream is the recorder's messages concatenated, possibly split across chunks, so the parser buffers until a
 * whole message is present, then emits it.
 * @param onMessage - Invoked for each complete message. Messages of an unknown kind are skipped.
 * @returns The parser.
 */
export function createRawMessageParser(onMessage: (message: RawMessage) => void): RawMessageParser {

  let buffer: Buffer = Buffer.alloc(0);

  return {

    push: (chunk: Buffer): void => {

      buffer = (buffer.length === 0) ? chunk : Buffer.concat([ buffer, chunk ]);

      while(buffer.length >= RAW_HEADER_SIZE) {

        const length = buffer.readUInt32LE(0);

        if((length < RAW_HEADER_SIZE) || (length > RAW_MAX_MESSAGE_SIZE)) {

          throw new Error("Raw capture framing is broken: a message claims " + String(length) + " bytes.");
        }

        if(buffer.length < length) {

          return;
        }

        const kind = buffer.readUInt8(4);
        const detail = buffer.readUInt8(5);
        const timestamp = buffer.readDoubleLE(8);
        const first = buffer.readUInt32LE(16);
        const second = buffer.readUInt32LE(20);
        const data = buffer.subarray(RAW_HEADER_SIZE, length);

        buffer = buffer.subarray(length);

        if(kind === RAW_KIND_VIDEO) {

          onMessage({ data, format: FORMAT_NAMES.get(detail) ?? "unknown", height: second, kind: "video", timestamp, width: first });
        } else if(kind === RAW_KIND_AUDIO) {

          onMessage({ channels: detail, data, frames: second, kind: "audio", sampleRate: first, timestamp });
        }
      }
    }
  };
}

// Video.

/**
 * Converts a raw frame to packed yuv420p at its own size, the one layout the encoder's pipe takes. I420 passes through; NV12's interleaved chroma is split; the
 * RGB formats are converted with BT.709 limited-range coefficients, which is what HD video decoders assume. Odd sizes are not supported, since 4:2:0 needs even
 * ones and every capture preset is even.
 * @param frame - The frame as the recorder sent it.
 * @returns The yuv420p frame, or null for a format or size it cannot convert.
 */
export function toI420(frame: RawVideoMessage): Nullable<Buffer> {

  const { data, height, width } = frame;
  const lumaSize = width * height;
  const chromaSize = lumaSize / 4;
  const frameSize = lumaSize + (2 * chromaSize);

  if(((width % 2) !== 0) || ((height % 2) !== 0)) {

    return null;
  }

  switch(frame.format) {

    case "I420":
    case "I420A":

      return (data.length >= frameSize) ? data.subarray(0, frameSize) : null;

    case "NV12": {

      if(data.length < frameSize) {

        return null;
      }

      const out = Buffer.allocUnsafe(frameSize);

      data.copy(out, 0, 0, lumaSize);

      for(let i = 0; i < chromaSize; i++) {

        out[lumaSize + i] = (data[lumaSize + (2 * i)] ?? 0);
        out[lumaSize + chromaSize + i] = (data[lumaSize + (2 * i) + 1] ?? 0);
      }

      return out;
    }

    case "BGRA":
    case "BGRX":
    case "RGBA":
    case "RGBX":

      return (data.length >= (lumaSize * 4)) ? rgbToI420(data, width, height, frame.format.startsWith("B")) : null;

    default:

      return null;
  }
}

/**
 * BT.709 limited-range RGB to yuv420p, chroma from the 2x2 average.
 * @param data - Four bytes per pixel.
 * @param width - Frame width, even.
 * @param height - Frame height, even.
 * @param bgr - True when the byte order is B, G, R.
 * @returns The yuv420p frame.
 */
function rgbToI420(data: Buffer, width: number, height: number, bgr: boolean): Buffer {

  const lumaSize = width * height;
  const chromaWidth = width / 2;
  const out = Buffer.allocUnsafe(lumaSize + (lumaSize / 2));
  const rOffset = bgr ? 2 : 0;
  const bOffset = bgr ? 0 : 2;

  for(let y = 0; y < height; y += 2) {

    for(let x = 0; x < width; x += 2) {

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;

      for(let dy = 0; dy < 2; dy++) {

        for(let dx = 0; dx < 2; dx++) {

          const pixel = (((y + dy) * width) + x + dx) * 4;
          const r = (data[pixel + rOffset] ?? 0);
          const g = (data[pixel + 1] ?? 0);
          const b = (data[pixel + bOffset] ?? 0);

          // Y' = 16 + 219 * (0.2126 R + 0.7152 G + 0.0722 B) / 255, in 8.8 fixed point.
          out[((y + dy) * width) + x + dx] = 16 + (((47 * r) + (157 * g) + (16 * b)) >> 8);
          rSum += r;
          gSum += g;
          bSum += b;
        }
      }

      const chroma = ((y / 2) * chromaWidth) + (x / 2);

      // Cb and Cr from the averaged pixel, 8.8 fixed point; the sums are of four pixels, hence the extra two bits of shift. Each row of coefficients sums to zero so
      // grays stay exactly neutral.
      out[lumaSize + chroma] = 128 + (((-26 * rSum) - (86 * gSum) + (112 * bSum)) >> 10);
      out[lumaSize + (lumaSize / 4) + chroma] = 128 + (((112 * rSum) - (102 * gSum) - (10 * bSum)) >> 10);
    }
  }

  return out;
}

/**
 * Records a timestamp on the shared timeline. When it lands more than RAW_MAX_GAP_US after the latest one either stream has shown, nothing arrived from the tab
 * for that long, and the origin moves forward by the gap so both pacers carry on from where they were rather than filling it.
 * @param timeline - The shared timeline, with its origin already set.
 * @param timestampUs - The arriving timestamp.
 * @returns True when the timestamp ended a stall.
 */
export function observeTimestamp(timeline: RawTimeline, timestampUs: number): boolean {

  const latest = timeline.latestUs;

  if((latest === null) || (timestampUs <= latest)) {

    timeline.latestUs ??= timestampUs;

    return false;
  }

  timeline.latestUs = timestampUs;

  if(((timestampUs - latest) > RAW_MAX_GAP_US) && (timeline.originUs !== null)) {

    timeline.originUs += timestampUs - latest;

    return true;
  }

  return false;
}

/**
 * Creates the video pacer: the decision of which output slot each frame fills.
 * @param timeline - The origin shared with the audio pacer. The first frame sets it.
 * @param frameRate - The output frame rate.
 * @param onStall - Invoked when a frame ended a stall.
 * @returns The placement function, given a frame's capture timestamp in microseconds.
 */
export function createVideoPacer(timeline: RawTimeline, frameRate: number, onStall: () => void = (): void => { /* No stall observer. */ }):
(timestampUs: number) => VideoPlacement {

  const intervalUs = MICROSECONDS_PER_SECOND / frameRate;
  let written = 0;

  return (timestampUs: number): VideoPlacement => {

    if(timeline.originUs === null) {

      timeline.originUs = timestampUs;
      timeline.latestUs = timestampUs;
      written = 1;

      return { emit: true, repeats: 0 };
    }

    if(observeTimestamp(timeline, timestampUs)) {

      onStall();
    }

    const slot = Math.round((timestampUs - timeline.originUs) / intervalUs);

    // A frame for a slot already written: its content waits for the next repeat.
    if(slot < written) {

      return { emit: false, repeats: 0 };
    }

    const repeats = slot - written;

    written = slot + 1;

    return { emit: true, repeats };
  };
}

// Audio.

/**
 * Converts a raw audio block to interleaved stereo at the output rate. Mono is duplicated to both channels, channels past the second are dropped, and a block at
 * another rate is resampled linearly, which is plenty for the 44.1 kHz a tab can occasionally produce.
 * @param block - The block as the recorder sent it.
 * @returns Interleaved stereo samples.
 */
export function toStereoOutput(block: RawAudioMessage): Float32Array {

  const { channels, frames, sampleRate } = block;

  if((channels === 0) || (frames === 0) || (block.data.length < (channels * frames * 4))) {

    return new Float32Array(0);
  }

  // A Float32Array view needs a 4-byte-aligned offset, which a payload sliced out of the parser's buffer need not have; such a block is copied first.
  const bytes = ((block.data.byteOffset % 4) === 0) ? block.data : Buffer.from(block.data);
  const planes = new Float32Array(bytes.buffer, bytes.byteOffset, channels * frames);
  const left = planes.subarray(0, frames);
  const right = (channels > 1) ? planes.subarray(frames, 2 * frames) : left;
  const outFrames = (sampleRate === RAW_AUDIO_SAMPLE_RATE) ? frames : Math.round(frames * RAW_AUDIO_SAMPLE_RATE / sampleRate);
  const out = new Float32Array(outFrames * RAW_AUDIO_CHANNELS);

  for(let i = 0; i < outFrames; i++) {

    if(outFrames === frames) {

      out[2 * i] = (left[i] ?? 0);
      out[(2 * i) + 1] = (right[i] ?? 0);

      continue;
    }

    const position = i * sampleRate / RAW_AUDIO_SAMPLE_RATE;
    const index = Math.floor(position);
    const next = Math.min(index + 1, frames - 1);
    const fraction = position - index;

    out[2 * i] = ((left[index] ?? 0) * (1 - fraction)) + ((left[next] ?? 0) * fraction);
    out[(2 * i) + 1] = ((right[index] ?? 0) * (1 - fraction)) + ((right[next] ?? 0) * fraction);
  }

  return out;
}

/**
 * Creates the audio pacer: the decision of where each block lands on the shared timeline.
 * @param timeline - The origin shared with the video pacer. Audio waits for video to set it.
 * @param onAdjust - Invoked with the silence padded (positive) or samples trimmed (negative) for a block.
 * @returns The placement function, given a block's capture timestamp and its interleaved stereo samples; it returns what to write, which may be empty.
 */
export function createAudioPacer(timeline: RawTimeline, onAdjust: (frames: number) => void = (): void => { /* No adjustment observer. */ }):
(timestampUs: number, samples: Float32Array) => Float32Array {

  let written = 0;

  return (timestampUs: number, samples: Float32Array): Float32Array => {

    // Audio ahead of the first video frame has nothing to align to.
    if(timeline.originUs === null) {

      return new Float32Array(0);
    }

    observeTimestamp(timeline, timestampUs);

    const target = Math.round((timestampUs - timeline.originUs) * RAW_AUDIO_SAMPLE_RATE / MICROSECONDS_PER_SECOND);
    const frames = samples.length / RAW_AUDIO_CHANNELS;
    const offset = target - written;

    if(Math.abs(offset) <= RAW_AUDIO_TOLERANCE_SAMPLES) {

      written += frames;

      return samples;
    }

    if(offset > 0) {

      const padded = new Float32Array((offset + frames) * RAW_AUDIO_CHANNELS);

      padded.set(samples, offset * RAW_AUDIO_CHANNELS);
      written += offset + frames;
      onAdjust(offset);

      return padded;
    }

    // Overlap: drop the part of the block the output has already covered.
    const trim = Math.min(-offset, frames);

    written += frames - trim;
    onAdjust(-trim);

    return samples.subarray(trim * RAW_AUDIO_CHANNELS);
  };
}

// The pump.

/**
 * Creates a pump. Pipe the raw capture stream into it; it writes yuv420p frames to videoOut and f32le stereo 48 kHz audio to audioOut, and ends both when the
 * capture stream ends. The input never waits on the outputs, because the capture is live: when the encoder falls so far behind that the video pipe holds more
 * than maxBufferedBytes, the pump fails with an error instead, which the stream's recovery treats like any other capture failure.
 * @param options - The output geometry, rate, and pipes.
 * @returns The pump.
 */
export function createRawPump(options: RawPumpOptions): RawPump {

  const { audioOut, frameRate, height, maxBufferedBytes = RAW_PUMP_MAX_BUFFERED_BYTES, videoOut, width } = options;
  const stats: RawPumpStats = { audioSamplesPadded: 0, audioSamplesTrimmed: 0, framesDropped: 0, framesRejected: 0, framesRepeated: 0, framesWritten: 0, stalls: 0 };
  const timeline: RawTimeline = { latestUs: null, originUs: null };
  const placeVideo = createVideoPacer(timeline, frameRate, () => { stats.stalls++; });
  const placeAudio = createAudioPacer(timeline, (frames) => {

    if(frames > 0) {

      stats.audioSamplesPadded += frames;
    } else {

      stats.audioSamplesTrimmed -= frames;
    }
  });

  let lastFrame: Nullable<Buffer> = null;
  let warnedRejection = false;

  const writeFrame = (frame: Buffer): void => {

    videoOut.write(frame);
    stats.framesWritten++;
  };

  const handleVideo = (message: RawVideoMessage): void => {

    const frame = ((message.width === width) && (message.height === height)) ? toI420(message) : null;

    if(!frame) {

      stats.framesRejected++;

      if(!warnedRejection) {

        warnedRejection = true;
        LOG.warn("Raw capture sent a frame the encoder pipe cannot take (%s %dx%d, expected %dx%d); such frames are skipped.", message.format, message.width,
          message.height, width, height);
      }

      return;
    }

    const placement = placeVideo(message.timestamp);

    if(lastFrame) {

      for(let i = 0; i < placement.repeats; i++) {

        writeFrame(lastFrame);
        stats.framesRepeated++;
      }
    }

    if(placement.emit) {

      writeFrame(frame);
    } else {

      stats.framesDropped++;
    }

    // Kept for repeats without a copy: the parser only ever slices its buffers and replaces them, never writes into one, so the bytes stay as they are.
    lastFrame = frame;
  };

  const handleAudio = (message: RawAudioMessage): void => {

    const samples = placeAudio(message.timestamp, toStereoOutput(message));

    if(samples.length > 0) {

      audioOut.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    }
  };

  const parser = createRawMessageParser((message) => {

    if(message.kind === "video") {

      handleVideo(message);
    } else {

      handleAudio(message);
    }
  });

  const pump = new Writable({

    final: (callback): void => {

      videoOut.end();
      audioOut.end();
      callback();
    },

    write: (chunk: Buffer, _encoding, callback): void => {

      try {

        parser.push(chunk);
      } catch(error) {

        callback(error as Error);

        return;
      }

      if(videoOut.writableLength > maxBufferedBytes) {

        callback(new Error("The video encoder fell behind the capture: " + String(Math.round(videoOut.writableLength / 1048576)) + "MB of frames are waiting."));

        return;
      }

      callback();
    }
  });

  return Object.assign(pump, { stats });
}

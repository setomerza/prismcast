/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rawPump.ts: Paces the raw audio recorder's messages into the audio pipe of an FFmpeg that grabs its video from the screen.
 *
 * In the FFmpeg encoder mode FFmpeg reads two inputs: its x11grab of the stream's window, which it stamps with the wall clock from the moment it starts, and 48 kHz
 * stereo 32-bit float PCM on a pipe, which carries no timestamps at all - FFmpeg simply counts samples. The raw recorder (browser/rawCapture.ts) sends audio
 * blocks as Chrome captures them, stamped with the track's own capture clock. So the pump's job is to turn timestamped, irregular arrivals into one continuous
 * stream whose sample count stays level with the wall clock FFmpeg's video runs on:
 *
 * - The first block is anchored where the wall clock stands when it arrives, measured from the encoder's start, and preceded by that much silence.
 * - Each later block lands at the sample its own timestamp names relative to that anchor. A disagreement with what has been written up to the tolerance is
 *   absorbed as jitter; a larger gap is filled with silence and a larger overlap is trimmed.
 * - When a block's place by its own clock and the wall clock's place for it drift apart by more than the drift limit - the tab stalled, the track's clock
 *   restarted, or its rate has drifted against the system's over a long stream - the block is re-anchored to the wall clock.
 *
 * Chrome does not promise that a capture's audio timestamps share a time base with anything else, which is why only differences between them are ever used.
 */
import { RAW_HEADER_SIZE, RAW_KIND_AUDIO } from "../browser/rawCapture.ts";
import type { Clock } from "homebridge-plugin-utils";
import type { Nullable } from "../types/index.ts";
import { Writable } from "node:stream";
import { systemClock } from "homebridge-plugin-utils";

// Constants.

// The audio the pump writes: what FFmpeg is told to read on the audio pipe.
export const RAW_AUDIO_SAMPLE_RATE = 48000;
export const RAW_AUDIO_CHANNELS = 2;

// The disagreement between a block's place and what has been written that is absorbed as jitter rather than corrected, in samples: 20ms.
export const RAW_AUDIO_TOLERANCE_SAMPLES = 960;

// The disagreement between a block's own clock and the wall clock past which the block is re-anchored to the wall clock, in samples: 60ms. Arrival jitter alone
// stays well inside it, so it only fires for a stall, a clock restart, or drift that has built up.
export const RAW_AUDIO_DRIFT_LIMIT_SAMPLES = 2880;

// How much unwritten audio the pump lets FFmpeg's pipe hold before it declares the encoder stalled and fails the stream. About ten seconds of audio.
export const RAW_PUMP_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

// Timestamps are in microseconds and the clock reads milliseconds.
const MICROSECONDS_PER_SECOND = 1000000;
const MICROSECONDS_PER_MILLISECOND = 1000;

// The largest message the parser accepts. Chrome hands audio over in blocks of a few hundred frames, so anything near this is broken framing.
const RAW_MAX_MESSAGE_SIZE = 4 * 1024 * 1024;

// Types.

/**
 * One block of raw audio as the recorder sent it: planar 32-bit float, one plane per channel.
 */
export interface RawAudioMessage {

  readonly channels: number;
  readonly data: Buffer;
  readonly frames: number;
  readonly sampleRate: number;
  readonly timestamp: number;
}

/**
 * Streaming parser for the recorder's self-delimiting messages.
 */
export interface RawMessageParser {

  // Push a chunk of the capture stream. Throws when the framing is broken, since the framing is ours and there is nothing to resync to.
  push: (chunk: Buffer) => void;
}

/**
 * The counts a pump keeps for its stream's diagnostics.
 */
export interface RawPumpStats {

  blocksWritten: number;
  reanchors: number;
  samplesPadded: number;
  samplesTrimmed: number;
}

/**
 * What a pump is built with: the pipe to write, and when the encoder it feeds started, by the clock the pump paces against.
 */
export interface RawPumpOptions {

  readonly audioOut: Writable;
  readonly clock?: Clock;
  readonly maxBufferedBytes?: number;

  // The clock's reading, in milliseconds, when the encoder FFmpeg was spawned: the moment its grabbed video's timeline starts.
  readonly startedAt: number;
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
 * @param onAudio - Invoked for each complete audio message. Messages of any other kind are skipped.
 * @returns The parser.
 */
export function createRawMessageParser(onAudio: (message: RawAudioMessage) => void): RawMessageParser {

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
        const message = { channels: buffer.readUInt8(5), data: buffer.subarray(RAW_HEADER_SIZE, length), frames: buffer.readUInt32LE(20),
          sampleRate: buffer.readUInt32LE(16), timestamp: buffer.readDoubleLE(8) };

        buffer = buffer.subarray(length);

        if(kind === RAW_KIND_AUDIO) {

          onAudio(message);
        }
      }
    }
  };
}

// Conversion.

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

// Pacing.

/**
 * Creates the audio pacer: the decision of where each block lands in the audio output.
 * @param elapsedUs - Reads how long the encoder has been running, in microseconds of wall clock: where the grabbed video's timeline stands.
 * @param onAdjust - Invoked with the silence padded (positive) or samples trimmed (negative) for a block.
 * @param onReanchor - Invoked when a block is re-anchored to the wall clock.
 * @returns The placement function, given a block's capture timestamp and its interleaved stereo samples; it returns what to write, which may be empty.
 */
export function createAudioPacer(elapsedUs: () => number, onAdjust: (frames: number) => void = (): void => { /* No adjustment observer. */ },
  onReanchor: () => void = (): void => { /* No re-anchor observer. */ }): (timestampUs: number, samples: Float32Array) => Float32Array {

  let anchor: Nullable<{ sample: number; timestampUs: number }> = null;
  let written = 0;

  return (timestampUs: number, samples: Float32Array): Float32Array => {

    const wallSample = Math.round(elapsedUs() * RAW_AUDIO_SAMPLE_RATE / MICROSECONDS_PER_SECOND);

    anchor ??= { sample: wallSample, timestampUs };

    let target = anchor.sample + Math.round((timestampUs - anchor.timestampUs) * RAW_AUDIO_SAMPLE_RATE / MICROSECONDS_PER_SECOND);

    if(Math.abs(target - wallSample) > RAW_AUDIO_DRIFT_LIMIT_SAMPLES) {

      anchor = { sample: wallSample, timestampUs };
      target = wallSample;
      onReanchor();
    }

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
 * Creates a pump. Pipe the raw capture stream into it; it writes f32le stereo 48 kHz audio to audioOut, level with the wall clock since startedAt, and ends the
 * pipe when the capture stream ends. The input never waits on the output, because the capture is live: when the encoder stops reading so long that the pipe
 * holds more than maxBufferedBytes, the pump fails with an error instead, which the stream's recovery treats like any other capture failure.
 * @param options - The pipe, the clock, and the encoder's start.
 * @returns The pump.
 */
export function createRawPump(options: RawPumpOptions): RawPump {

  const { audioOut, clock = systemClock, maxBufferedBytes = RAW_PUMP_MAX_BUFFERED_BYTES, startedAt } = options;
  const stats: RawPumpStats = { blocksWritten: 0, reanchors: 0, samplesPadded: 0, samplesTrimmed: 0 };
  const place = createAudioPacer(() => (clock.now() - startedAt) * MICROSECONDS_PER_MILLISECOND, (frames) => {

    if(frames > 0) {

      stats.samplesPadded += frames;
    } else {

      stats.samplesTrimmed -= frames;
    }
  }, () => { stats.reanchors++; });

  const parser = createRawMessageParser((message) => {

    const samples = place(message.timestamp, toStereoOutput(message));

    if(samples.length > 0) {

      audioOut.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
      stats.blocksWritten++;
    }
  });

  const pump = new Writable({

    final: (callback): void => {

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

      if(audioOut.writableLength > maxBufferedBytes) {

        callback(new Error("The encoder stopped reading its audio: " + String(Math.round(audioOut.writableLength / 1024)) + "KB are waiting."));

        return;
      }

      callback();
    }
  });

  return Object.assign(pump, { stats });
}

/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rawPump.test.ts: Unit tests for the raw audio pump: the message framing it parses, the sample conversion, the pacer that keeps the audio level with the wall
 * clock the grabbed video runs on, and the pump that ties them to FFmpeg's audio pipe. Messages are built here with the layout the recorder writes, the pipe is an
 * in-memory writable, and time is a virtual clock, so nothing outside Node is involved.
 */
import { RAW_AUDIO_CHANNELS, RAW_AUDIO_DRIFT_LIMIT_SAMPLES, RAW_AUDIO_SAMPLE_RATE, RAW_AUDIO_TOLERANCE_SAMPLES, createAudioPacer, createRawMessageParser,
  createRawPump, toStereoOutput } from "./rawPump.ts";
import { RAW_HEADER_SIZE, RAW_KIND_AUDIO } from "../browser/rawCapture.ts";
import { describe, test } from "node:test";
import type { RawAudioMessage } from "./rawPump.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import { Writable } from "node:stream";
import assert from "node:assert/strict";

// Helpers.

/**
 * Builds one message in the recorder's wire layout.
 * @param kind - The message kind.
 * @param channels - The channel count.
 * @param timestamp - Microseconds.
 * @param sampleRate - The block's rate.
 * @param frames - Frames per channel.
 * @param payload - The payload bytes.
 * @returns The framed message.
 */
function frameMessage(kind: number, channels: number, timestamp: number, sampleRate: number, frames: number, payload: Buffer): Buffer {

  const header = Buffer.alloc(RAW_HEADER_SIZE);

  header.writeUInt32LE(RAW_HEADER_SIZE + payload.length, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt8(channels, 5);
  header.writeDoubleLE(timestamp, 8);
  header.writeUInt32LE(sampleRate, 16);
  header.writeUInt32LE(frames, 20);

  return Buffer.concat([ header, payload ]);
}

/**
 * Builds a stereo 48 kHz audio message of constant samples.
 * @param timestamp - Microseconds.
 * @param frames - Frames per channel.
 * @param value - The sample value.
 * @returns The framed message.
 */
function audioMessage(timestamp: number, frames: number, value: number): Buffer {

  const payload = Buffer.alloc(frames * 2 * 4);

  for(let i = 0; i < frames * 2; i++) {

    payload.writeFloatLE(value, i * 4);
  }

  return frameMessage(RAW_KIND_AUDIO, 2, timestamp, RAW_AUDIO_SAMPLE_RATE, frames, payload);
}

/**
 * An in-memory pipe that keeps every write.
 * @returns The writable, the chunks it received, and whether it was ended.
 */
function makeSink(): { chunks: Buffer[]; ended: () => boolean; sink: Writable } {

  const chunks: Buffer[] = [];
  let finished = false;

  const sink = new Writable({

    final: (callback): void => {

      finished = true;
      callback();
    },
    write: (chunk: Buffer, _encoding, callback): void => {

      chunks.push(chunk);
      callback();
    }
  });

  return { chunks, ended: (): boolean => finished, sink };
}

/**
 * Writes chunks into a pump and ends it, resolving once it has finished or failed.
 * @param pump - The pump.
 * @param chunks - What to write.
 * @returns The error the pump failed with, if any.
 */
async function drive(pump: Writable, chunks: Buffer[]): Promise<Error | undefined> {

  return new Promise((resolve) => {

    pump.once("error", (error) => { resolve(error); });
    pump.once("finish", () => { resolve(undefined); });

    for(const chunk of chunks) {

      pump.write(chunk);
    }

    pump.end();
  });
}

// Parsing.

describe("createRawMessageParser", () => {

  test("parses whole messages, messages split across chunks, and several messages in one chunk", () => {

    const messages: RawAudioMessage[] = [];
    const parser = createRawMessageParser((message) => { messages.push(message); });
    const both = Buffer.concat([ audioMessage(1000, 4, 0.5), audioMessage(2000, 8, 0.25) ]);

    // One byte at a time is the harshest split there is.
    for(let i = 0; i < both.length; i++) {

      parser.push(both.subarray(i, i + 1));
    }

    parser.push(both);

    assert.equal(messages.length, 4, "every message is emitted once, however it was split");
    assert.deepEqual([ messages[0]?.channels, messages[0]?.sampleRate, messages[0]?.frames, messages[0]?.timestamp ], [ 2, RAW_AUDIO_SAMPLE_RATE, 4, 1000 ]);
    assert.deepEqual([ messages[1]?.frames, messages[1]?.timestamp, messages[1]?.data.length ], [ 8, 2000, 64 ]);
  });

  test("skips messages of any other kind, including the retired video kind", () => {

    const messages: RawAudioMessage[] = [];
    const parser = createRawMessageParser((message) => { messages.push(message); });

    parser.push(frameMessage(1, 0, 0, 4, 2, Buffer.alloc(12)));
    parser.push(frameMessage(9, 0, 0, 0, 0, Buffer.alloc(4)));
    parser.push(audioMessage(0, 1, 0));

    assert.equal(messages.length, 1);
  });

  test("throws on broken framing rather than guessing", () => {

    const parser = createRawMessageParser(() => { /* Never reached. */ });
    const broken = Buffer.alloc(RAW_HEADER_SIZE);

    broken.writeUInt32LE(3, 0);

    assert.throws(() => { parser.push(broken); }, /framing is broken/);
  });
});

// Conversion.

describe("toStereoOutput", () => {

  const block = (channels: number, frames: number, sampleRate: number, samples: number[], misalign = false): RawAudioMessage => {

    const bytes = Buffer.alloc((samples.length * 4) + (misalign ? 1 : 0));

    samples.forEach((sample, i) => { bytes.writeFloatLE(sample, (i * 4) + (misalign ? 1 : 0)); });

    return { channels, data: misalign ? bytes.subarray(1) : bytes, frames, sampleRate, timestamp: 0 };
  };

  test("interleaves stereo, duplicates mono, and drops channels past the second", () => {

    assert.deepEqual([...toStereoOutput(block(2, 2, 48000, [ 0.25, 0.5, -0.25, -0.5 ]))], [ 0.25, -0.25, 0.5, -0.5 ]);
    assert.deepEqual([...toStereoOutput(block(1, 2, 48000, [ 0.25, 0.5 ]))], [ 0.25, 0.25, 0.5, 0.5 ]);
    assert.deepEqual([...toStereoOutput(block(3, 1, 48000, [ 0.25, 0.5, 0.75 ]))], [ 0.25, 0.5 ]);
  });

  test("reads a payload at an unaligned offset", () => {

    assert.deepEqual([...toStereoOutput(block(2, 1, 48000, [ 0.25, 0.5 ], true))], [ 0.25, 0.5 ]);
  });

  test("resamples another rate to the output rate", () => {

    const frames = 441;
    const out = toStereoOutput(block(1, frames, 44100, Array.from({ length: frames }, () => 0.5)));

    assert.equal(out.length / RAW_AUDIO_CHANNELS, 480, "441 frames at 44.1 kHz become 480 at 48 kHz");
    assert.ok(out.every((sample) => Math.abs(sample - 0.5) < 1e-6), "a constant stays constant");
  });

  test("an empty or short block becomes nothing", () => {

    assert.equal(toStereoOutput(block(0, 0, 48000, [])).length, 0);
    assert.equal(toStereoOutput({ channels: 2, data: Buffer.alloc(4), frames: 4, sampleRate: 48000, timestamp: 0 }).length, 0);
  });
});

// Pacing.

describe("createAudioPacer", () => {

  const samples = (frames: number, value = 0.5): Float32Array => new Float32Array(frames * RAW_AUDIO_CHANNELS).fill(value);

  test("anchors the first block at the wall clock's position, whatever the block's own time base", () => {

    let elapsed = 100000;
    const place = createAudioPacer(() => elapsed);

    // The track's clock reads in the billions; the encoder has been running 100ms, so the block lands after 100ms of silence.
    const first = place(9000000000, samples(480));

    assert.equal(first.length, (4800 + 480) * 2, "100ms of silence, then the block");
    assert.equal(first[0], 0, "the lead-in is silent");

    elapsed += 10000;

    assert.equal(place(9000010000, samples(480)).length, 480 * 2, "the next block follows on its own clock");

    elapsed += 15000;

    assert.equal(place(9000025000, samples(480)).length, 480 * 2, "5ms late by its own clock is jitter");
  });

  test("pads a gap with silence and trims an overlap, by the block's own clock", () => {

    let elapsed = 0;
    const adjustments: number[] = [];
    const place = createAudioPacer(() => elapsed, (frames) => { adjustments.push(frames); });

    place(0, samples(480));

    // The next block is stamped 50ms later than the 10ms written so far, and the wall clock agrees: 40ms of silence first.
    elapsed = 50000;

    const padded = place(50000, samples(480));
    const gap = 2400 - 480;

    assert.equal(padded.length, (gap + 480) * 2, "silence then the block");
    assert.equal(padded[(gap * 2) + 1], 0.5, "the block follows the pad");

    // The output now reaches 60ms. A block stamped 25ms overlaps by 35ms, more than its own 10ms, so none of it is written.
    assert.equal(place(25000, samples(480)).length, 0, "a block wholly behind the output is trimmed away");

    // A block overlapping by more than the tolerance loses only its overlap.
    const overlap = RAW_AUDIO_TOLERANCE_SAMPLES + 120;
    const partial = place(60000 - ((overlap * 1000000) / RAW_AUDIO_SAMPLE_RATE), samples(2000));

    assert.equal(partial.length, (2000 - overlap) * 2, "the overlapping head was trimmed");
    assert.deepEqual(adjustments, [ gap, -480, -overlap ]);
  });

  test("re-anchors to the wall clock when the block's own clock drifts past the limit", () => {

    let elapsed = 0;
    let reanchors = 0;
    const place = createAudioPacer(() => elapsed, () => { /* Not observed. */ }, () => { reanchors++; });

    place(0, samples(480));

    // The track's clock says 10ms passed; the wall clock says a second did. The block lands where the wall clock stands.
    elapsed = 1000000;

    const placed = place(10000, samples(480));

    assert.equal(reanchors, 1);
    assert.equal(placed.length, ((48000 - 480) + 480) * 2, "silence up to the wall clock's second, then the block");

    // A drift inside the limit is not a re-anchor.
    elapsed += 10000 + (((RAW_AUDIO_DRIFT_LIMIT_SAMPLES - 100) * 1000000) / RAW_AUDIO_SAMPLE_RATE);
    place(20000, samples(480));

    assert.equal(reanchors, 1);
  });
});

// The pump.

describe("createRawPump", () => {

  test("writes aligned audio from the encoder's start and ends the pipe when the capture ends", async () => {

    const clock = new TestClock();
    const audio = makeSink();
    const pump = createRawPump({ audioOut: audio.sink, clock, startedAt: clock.now() });

    // The first block arrives 30ms after the encoder started - past the jitter tolerance, so the lead-in is padded rather than absorbed.
    clock.advance(30);

    const error = await drive(pump, [ audioMessage(5000000, 480, 0.2), audioMessage(5010000, 480, 0.2) ]);

    assert.equal(error, undefined);
    assert.equal(Buffer.concat(audio.chunks).length, (1440 + 480 + 480) * 2 * 4, "30ms of lead-in silence, then two 10ms blocks");
    assert.deepEqual(pump.stats, { blocksWritten: 2, reanchors: 0, samplesPadded: 1440, samplesTrimmed: 0 });
    assert.ok(audio.ended(), "the pipe ended with the capture");
  });

  test("fails on broken framing", async () => {

    const pump = createRawPump({ audioOut: makeSink().sink, startedAt: 0 });
    const broken = Buffer.alloc(RAW_HEADER_SIZE);

    broken.writeUInt32LE(1, 0);

    assert.match((await drive(pump, [broken]))?.message ?? "", /framing is broken/);
  });

  test("fails when the encoder stops reading its audio", async () => {

    const clock = new TestClock();

    // A pipe that never drains: every write stays buffered.
    const stuck = new Writable({ highWaterMark: 1, write: (): void => { /* Never calls back. */ } });
    const pump = createRawPump({ audioOut: stuck, clock, maxBufferedBytes: 100, startedAt: clock.now() });

    assert.match((await drive(pump, [ audioMessage(0, 480, 0.1), audioMessage(10000, 480, 0.1) ]))?.message ?? "", /stopped reading/);
  });
});


describe("screen-capture audio calibration", () => {

  test("advances late audio by 250ms by reducing its lead-in", async () => {

    const clock = new TestClock();
    const audio = makeSink();
    const pump = createRawPump({ audioAdvanceMs: 250, audioOut: audio.sink, clock, startedAt: clock.now() });

    clock.advance(300);

    assert.equal(await drive(pump, [audioMessage(5000000, 480, 0.5)]), undefined);
    const output = Buffer.concat(audio.chunks);

    assert.equal(output.length, (2400 + 480) * 8, "50ms silence instead of 300ms, followed by the audio");
    assert.equal(output.readFloatLE(2400 * 8), 0.5);
  });

  test("negative correction delays early audio", async () => {

    const clock = new TestClock();
    const audio = makeSink();
    const pump = createRawPump({ audioAdvanceMs: -250, audioOut: audio.sink, clock, startedAt: clock.now() });

    clock.advance(30);

    assert.equal(await drive(pump, [audioMessage(5000000, 480, 0.5)]), undefined);
    assert.equal(Buffer.concat(audio.chunks).length, (13440 + 480) * 8, "280ms silence before the audio");
  });

  test("drops samples moved before video zero and retains correction after a clock restart", async () => {

    const clock = new TestClock();
    const audio = makeSink();
    const pump = createRawPump({ audioAdvanceMs: 250, audioOut: audio.sink, clock, startedAt: clock.now() });

    clock.advance(30);
    pump.write(audioMessage(5000000, 480, 0.25));
    assert.equal(audio.chunks.length, 0, "the block moved before video zero is dropped");
    clock.advance(970);

    assert.equal(await drive(pump, [audioMessage(0, 480, 0.5)]), undefined);
    assert.equal(pump.stats.reanchors, 1);
    assert.equal(Buffer.concat(audio.chunks).length, (36000 + 480) * 8, "re-anchor lands at 750ms, retaining the 250ms advance");
  });
});

/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * deferredEncoder.test.ts: Unit tests for the FFmpeg encoder mode's deferred encoder: that nothing is spawned until start(), that the capture's audio is dropped
 * until then without losing the recorder's framing, that the audio is anchored to the encoder's start, and that a kill on either side of the start tears down
 * what exists. The encoder is the shared FFmpeg double with an audio pipe, and time is a virtual clock.
 */
import { RAW_AUDIO_SAMPLE_RATE, RAW_AUDIO_TOLERANCE_SAMPLES } from "./rawPump.ts";
import { beforeEach, describe, test } from "node:test";
import type { EncoderFFmpegProcess } from "../utils/index.ts";
import { PassThrough } from "node:stream";
import { RAW_HEADER_SIZE } from "../browser/rawCapture.ts";
import { TestClock } from "homebridge-plugin-utils/testing";
import type { Writable } from "node:stream";
import assert from "node:assert/strict";
import { createDeferredEncoder } from "./deferredEncoder.ts";
import { makeFakeFFmpeg } from "../utils/ffmpeg.helpers.ts";

// Bytes per interleaved stereo f32 frame on the encoder's audio pipe.
const FRAME_BYTES = 2 * 4;

let audio: Buffer[];
let clock: TestClock;
let encoderProcess: EncoderFFmpegProcess & { kills: () => number };
let encoderStdout: PassThrough;
let spawns: number;

/**
 * Builds one raw audio message: stereo 48 kHz, constant samples.
 * @param timestamp - Microseconds.
 * @param frames - Frames per channel.
 * @returns The framed message.
 */
function rawAudio(timestamp: number, frames: number): Buffer {

  const payload = Buffer.alloc(frames * 2 * 4);
  const header = Buffer.alloc(RAW_HEADER_SIZE);

  header.writeUInt32LE(RAW_HEADER_SIZE + payload.length, 0);
  header.writeUInt8(2, 4);
  header.writeUInt8(2, 5);
  header.writeDoubleLE(timestamp, 8);
  header.writeUInt32LE(RAW_AUDIO_SAMPLE_RATE, 16);
  header.writeUInt32LE(frames, 20);

  return Buffer.concat([ header, payload ]);
}

/**
 * Builds a deferred encoder over the double, counting spawns.
 * @returns The deferred encoder.
 */
function makeEncoder(): ReturnType<typeof createDeferredEncoder> {

  return createDeferredEncoder({

    clock,
    spawn: (): EncoderFFmpegProcess => {

      spawns++;

      return encoderProcess;
    }
  });
}

/**
 * Writes a chunk into a writable and waits for it to be consumed.
 * @param sink - The writable.
 * @param chunk - The chunk.
 * @returns Once the write has called back.
 */
async function write(sink: Writable, chunk: Buffer): Promise<void> {

  return new Promise((resolve, reject) => {

    sink.write(chunk, (error) => {

      if(error) {

        reject(error);

        return;
      }

      resolve();
    });
  });
}

beforeEach(() => {

  audio = [];
  clock = new TestClock();
  encoderStdout = new PassThrough();
  encoderProcess = { ...makeFakeFFmpeg(), audioIn: new PassThrough(), stdout: encoderStdout };
  encoderProcess.audioIn.on("data", (chunk: Buffer) => { audio.push(chunk); });
  spawns = 0;
});

describe("createDeferredEncoder", () => {

  test("spawns nothing until start(), and spawns once however often start() is called", () => {

    const encoder = makeEncoder();

    assert.equal(spawns, 0, "construction spawns nothing");
    assert.equal(encoder.started, false);

    encoder.start();
    encoder.start();

    assert.equal(spawns, 1, "the first start spawns the encoder, and a second does nothing");
    assert.equal(encoder.started, true);
  });

  test("drops the capture's audio until start(), keeping the framing across a message split over the start", async () => {

    const encoder = makeEncoder();
    const early = rawAudio(0, 480);
    const straddling = rawAudio(10000, 480);

    await write(encoder.audioSink, early);
    await write(encoder.audioSink, straddling.subarray(0, 10));

    encoder.start();

    await write(encoder.audioSink, straddling.subarray(10));
    await write(encoder.audioSink, rawAudio(20000, 480));

    assert.equal(encoder.audioSink.stats.blocksWritten, 2, "the block that arrived whole before the start was dropped; the two completed after it were written");
    assert.equal(Buffer.concat(audio).length, 960 * FRAME_BYTES, "the two blocks follow one another with no lead-in");
  });

  test("anchors the audio to the encoder's start, not to the capture's", async () => {

    const encoder = makeEncoder();

    // The tune takes ten seconds, and the capture's audio flows the whole time.
    for(let i = 0; i < 10; i++) {

      // eslint-disable-next-line no-await-in-loop -- The capture's audio arrives in order, one block per second of the tune.
      await write(encoder.audioSink, rawAudio(i * 1000000, 480));
      clock.advance(1000);
    }

    encoder.start();

    // The first block after the start arrives 30ms in - past the jitter tolerance, so the lead-in is padded rather than absorbed.
    clock.advance(30);
    await write(encoder.audioSink, rawAudio(10030000, 480));

    const leadIn = (30 * RAW_AUDIO_SAMPLE_RATE) / 1000;

    assert.ok(leadIn > RAW_AUDIO_TOLERANCE_SAMPLES);
    assert.equal(Buffer.concat(audio).length, (leadIn + 480) * FRAME_BYTES, "30ms of lead-in silence from the encoder's start, then the block");
    assert.deepEqual(encoder.audioSink.stats, { blocksWritten: 1, reanchors: 0, samplesPadded: leadIn, samplesTrimmed: 0 });
  });

  test("carries the encoder's output, and its end, on the stdout it handed out before the start", async () => {

    const encoder = makeEncoder();
    const output: Buffer[] = [];
    const ended = new Promise<void>((resolve) => { encoder.stdout.on("end", resolve); });

    encoder.stdout.on("data", (chunk: Buffer) => { output.push(chunk); });
    encoder.start();
    encoderStdout.end(Buffer.from("fmp4"));

    await ended;

    assert.equal(Buffer.concat(output).toString(), "fmp4");
  });

  test("a kill before the start spawns nothing, ever, and closes stdout", () => {

    const encoder = makeEncoder();

    encoder.kill();
    encoder.start();

    assert.equal(spawns, 0, "a killed encoder is never spawned");
    assert.equal(encoder.isShuttingDown(), true);
    assert.equal(encoder.stdout.destroyed, true);
  });

  test("a kill after the start kills the encoder and closes stdout", () => {

    const encoder = makeEncoder();

    encoder.start();

    assert.equal(encoder.isShuttingDown(), false);

    encoder.kill();

    assert.equal(encoderProcess.kills(), 1, "the encoder's own kill runs, with its escalation");
    assert.equal(encoder.isShuttingDown(), true);
    assert.equal(encoder.stdout.destroyed, true);
  });

  test("the teardown flag follows the encoder's own, for a kill the caller made on the encoder directly", () => {

    const encoder = makeEncoder();

    encoder.start();
    encoderProcess.kill();

    assert.equal(encoder.isShuttingDown(), true);
  });

  test("a capture that ended before the start ends the audio pipe at the start", async () => {

    const encoder = makeEncoder();
    const finished = new Promise<void>((resolve) => { encoder.audioSink.on("finish", resolve); });

    encoder.audioSink.end();
    await finished;

    encoder.start();

    assert.equal(encoderProcess.audioIn.writableEnded, true);
  });
});

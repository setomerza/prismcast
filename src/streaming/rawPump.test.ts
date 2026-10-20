/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * rawPump.test.ts: Unit tests for the raw capture pump: the message framing it parses, the pixel and sample conversions, the two pacers that turn timestamped
 * arrivals into regular streams, and the pump that ties them to FFmpeg's pipes. Messages are built here with the same layout the recorder writes, and the pipes
 * are in-memory writables, so nothing outside Node is involved.
 */
import { RAW_AUDIO_CHANNELS, RAW_AUDIO_SAMPLE_RATE, RAW_AUDIO_TOLERANCE_SAMPLES, RAW_MAX_GAP_US, createAudioPacer, createRawMessageParser, createRawPump,
  createVideoPacer, toI420, toStereoOutput } from "./rawPump.ts";
import { RAW_HEADER_SIZE, RAW_KIND_AUDIO, RAW_KIND_VIDEO, RAW_PIXEL_FORMATS } from "../browser/rawCapture.ts";
import type { RawAudioMessage, RawMessage, RawTimeline, RawVideoMessage } from "./rawPump.ts";
import { describe, test } from "node:test";
import { Writable } from "node:stream";
import assert from "node:assert/strict";

// Helpers.

/**
 * Builds one message in the recorder's wire layout.
 * @param kind - The message kind.
 * @param detail - The format code or channel count.
 * @param timestamp - Microseconds.
 * @param first - Width or sample rate.
 * @param second - Height or frames.
 * @param payload - The payload bytes.
 * @returns The framed message.
 */
function frameMessage(kind: number, detail: number, timestamp: number, first: number, second: number, payload: Buffer): Buffer {

  const header = Buffer.alloc(RAW_HEADER_SIZE);

  header.writeUInt32LE(RAW_HEADER_SIZE + payload.length, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt8(detail, 5);
  header.writeDoubleLE(timestamp, 8);
  header.writeUInt32LE(first, 16);
  header.writeUInt32LE(second, 20);

  return Buffer.concat([ header, payload ]);
}

/**
 * Builds an I420 video message whose luma is filled with one value, so frames can be told apart in the output.
 * @param timestamp - Microseconds.
 * @param marker - The luma fill.
 * @param width - Frame width.
 * @param height - Frame height.
 * @returns The framed message.
 */
function videoMessage(timestamp: number, marker: number, width = 4, height = 2): Buffer {

  const payload = Buffer.alloc(width * height * 1.5, 128);

  payload.fill(marker, 0, width * height);

  return frameMessage(RAW_KIND_VIDEO, RAW_PIXEL_FORMATS["I420"]!, timestamp, width, height, payload);
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
 * @returns The writable and the chunks it received.
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

    const messages: RawMessage[] = [];
    const parser = createRawMessageParser((message) => { messages.push(message); });
    const first = videoMessage(1000, 10);
    const second = audioMessage(2000, 4, 0.5);
    const both = Buffer.concat([ first, second ]);

    // One byte at a time is the harshest split there is.
    for(let i = 0; i < both.length; i++) {

      parser.push(both.subarray(i, i + 1));
    }

    parser.push(both);

    assert.equal(messages.length, 4, "every message is emitted once, however it was split");

    const video = messages[0] as RawVideoMessage;
    const audio = messages[1] as RawAudioMessage;

    assert.deepEqual([ video.kind, video.format, video.width, video.height, video.timestamp, video.data.length ], [ "video", "I420", 4, 2, 1000, 12 ]);
    assert.deepEqual([ audio.kind, audio.channels, audio.sampleRate, audio.frames, audio.timestamp ], [ "audio", 2, RAW_AUDIO_SAMPLE_RATE, 4, 2000 ]);
  });

  test("skips messages of an unknown kind and names an unknown format as such", () => {

    const messages: RawMessage[] = [];
    const parser = createRawMessageParser((message) => { messages.push(message); });

    parser.push(frameMessage(9, 0, 0, 0, 0, Buffer.alloc(4)));
    parser.push(frameMessage(RAW_KIND_VIDEO, 0, 0, 2, 2, Buffer.alloc(6)));

    assert.equal(messages.length, 1, "the unknown kind was skipped");
    assert.equal((messages[0] as RawVideoMessage).format, "unknown");
  });

  test("throws on broken framing rather than guessing", () => {

    const parser = createRawMessageParser(() => { /* Never reached. */ });
    const broken = Buffer.alloc(RAW_HEADER_SIZE);

    broken.writeUInt32LE(3, 0);

    assert.throws(() => { parser.push(broken); }, /framing is broken/);
  });
});

// Conversions.

describe("toI420", () => {

  const base = { kind: "video" as const, timestamp: 0 };

  test("passes I420 through and splits NV12's interleaved chroma", () => {

    const i420 = Buffer.from([ 1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 30, 31 ]);

    assert.deepEqual(toI420({ ...base, data: i420, format: "I420", height: 2, width: 4 }), i420);

    const nv12 = Buffer.from([ 1, 2, 3, 4, 5, 6, 7, 8, 20, 30, 21, 31 ]);

    assert.deepEqual([...toI420({ ...base, data: nv12, format: "NV12", height: 2, width: 4 })!], [ 1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 30, 31 ]);
  });

  test("converts RGB with limited-range BT.709, honoring byte order", () => {

    const white = Buffer.alloc(16, 255);
    const converted = toI420({ ...base, data: white, format: "RGBA", height: 2, width: 2 })!;

    assert.deepEqual([...converted], [ 235, 235, 235, 235, 128, 128 ], "white is Y 235 with neutral chroma");

    // Pure red in RGBA and the same bytes read as BGRA (pure blue) must land on opposite sides of neutral Cb.
    const red = Buffer.from(Array.from({ length: 4 }, () => [ 255, 0, 0, 255 ]).flat());
    const asRed = toI420({ ...base, data: red, format: "RGBA", height: 2, width: 2 })!;
    const asBlue = toI420({ ...base, data: red, format: "BGRA", height: 2, width: 2 })!;

    assert.ok(asRed[4]! < 128, "red has Cb below neutral");
    assert.ok(asRed[5]! > 200, "red has a high Cr");
    assert.ok(asBlue[4]! > 200, "blue has a high Cb");
  });

  test("refuses odd sizes, short payloads, and unknown formats", () => {

    assert.equal(toI420({ ...base, data: Buffer.alloc(100), format: "I420", height: 3, width: 3 }), null);
    assert.equal(toI420({ ...base, data: Buffer.alloc(5), format: "I420", height: 2, width: 4 }), null);
    assert.equal(toI420({ ...base, data: Buffer.alloc(5), format: "NV12", height: 2, width: 4 }), null);
    assert.equal(toI420({ ...base, data: Buffer.alloc(5), format: "RGBA", height: 2, width: 4 }), null);
    assert.equal(toI420({ ...base, data: Buffer.alloc(100), format: "unknown", height: 2, width: 4 }), null);
  });
});

describe("toStereoOutput", () => {

  const block = (channels: number, frames: number, sampleRate: number, samples: number[], misalign = false): RawAudioMessage => {

    const bytes = Buffer.alloc((samples.length * 4) + (misalign ? 1 : 0));

    samples.forEach((sample, i) => { bytes.writeFloatLE(sample, (i * 4) + (misalign ? 1 : 0)); });

    return { channels, data: misalign ? bytes.subarray(1) : bytes, frames, kind: "audio", sampleRate, timestamp: 0 };
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
    assert.equal(toStereoOutput({ channels: 2, data: Buffer.alloc(4), frames: 4, kind: "audio", sampleRate: 48000, timestamp: 0 }).length, 0);
  });
});

// Pacing.

describe("createVideoPacer", () => {

  test("places frames by timestamp: on time, late with repeats, and early without a write", () => {

    const timeline: RawTimeline = { videoPositionUs: null };
    const place = createVideoPacer(timeline, 30);
    const interval = 1000000 / 30;

    assert.deepEqual(place(5000000), { emit: true, repeats: 0 }, "the first frame anchors the track and is written");
    assert.equal(timeline.videoPositionUs, 0, "the first frame starts the output");
    assert.deepEqual(place(5000000 + interval), { emit: true, repeats: 0 }, "the next slot, on time");
    assert.deepEqual(place(5000000 + (4 * interval)), { emit: true, repeats: 2 }, "two missed slots are repeats of the previous frame");
    assert.deepEqual(place(5000000 + (4.2 * interval)), { emit: false, repeats: 0 }, "a second frame for a slot already written is not written");
    assert.deepEqual(place(5000000 + (4.6 * interval)), { emit: true, repeats: 0 }, "jitter rounds to the nearest slot");
    assert.equal(timeline.videoPositionUs, 5 * interval, "the sixth frame starts five intervals in");
  });

  test("a jump either way re-anchors the track instead of filling the gap, and says so", () => {

    const timeline: RawTimeline = { videoPositionUs: null };
    let stalls = 0;
    const place = createVideoPacer(timeline, 30, () => { stalls++; });

    place(0);
    place(33333);

    assert.deepEqual(place(33333 + RAW_MAX_GAP_US + 500000), { emit: true, repeats: 0 }, "a forward jump takes the next slot with no repeats");
    assert.deepEqual(place(33333 + RAW_MAX_GAP_US + 533333), { emit: true, repeats: 0 }, "and the track carries on from its new anchor");
    assert.deepEqual(place(10), { emit: true, repeats: 0 }, "a clock that restarts backwards also takes the next slot");
    assert.equal(stalls, 2, "both jumps were reported");
  });
});

describe("createAudioPacer", () => {

  const samples = (frames: number, value = 0.5): Float32Array => new Float32Array(frames * RAW_AUDIO_CHANNELS).fill(value);

  test("drops audio until video starts, then anchors at the video's position whatever the audio's time base", () => {

    const timeline: RawTimeline = { videoPositionUs: null };
    const place = createAudioPacer(timeline);

    assert.equal(place(0, samples(480)).length, 0, "no video yet");

    // The audio's clock is unrelated to the video's: its timestamps are in the billions while the video's started at zero. The video has written 100ms.
    timeline.videoPositionUs = 100000;

    const first = place(9000000000, samples(480));

    assert.equal(first.length, (4800 + 480) * 2, "the first block lands at the video's 100ms, after that much silence");
    assert.equal(place(9000010000, samples(480)).length, 480 * 2, "the next block follows on its own clock");
    assert.equal(place(9000025000, samples(480)).length, 480 * 2, "5ms late is jitter");
  });

  test("re-anchors a block that disagrees with its anchor by more than the gap limit", () => {

    const timeline: RawTimeline = { videoPositionUs: 0 };
    const place = createAudioPacer(timeline);

    place(0, samples(480));
    timeline.videoPositionUs = 500000;

    // The audio clock jumps three seconds; the video has only moved to 500ms, so the block lands there, after the silence that brings the audio level.
    const placed = place(RAW_MAX_GAP_US + 1000000, samples(480));

    assert.equal(placed.length, ((24000 - 480) + 480) * 2, "the block landed at the video's position");
  });

  test("pads a gap with silence and trims an overlap", () => {

    const timeline: RawTimeline = { videoPositionUs: 0 };
    const adjustments: number[] = [];
    const place = createAudioPacer(timeline, (frames) => { adjustments.push(frames); });

    place(0, samples(480));

    // The next block lands 100ms later than the 10ms written so far: 90ms of silence first.
    const padded = place(100000, samples(480));
    const gap = 4800 - 480;

    assert.equal(padded.length, (gap + 480) * 2, "silence then the block");
    assert.equal(padded[0], 0, "the pad is silent");
    assert.equal(padded[(gap * 2) + 1], 0.5, "the block follows the pad");

    // The output now reaches 110ms. A block stamped 50ms overlaps by 60ms, more than its own 10ms, so none of it is written.
    assert.equal(place(50000, samples(480)).length, 0, "a block wholly behind the output is trimmed away");

    // A block overlapping by more than the tolerance loses only its overlap.
    const partial = place(110000 - (((RAW_AUDIO_TOLERANCE_SAMPLES + 120) * 1000000) / RAW_AUDIO_SAMPLE_RATE), samples(2000));

    assert.equal(partial.length, (2000 - (RAW_AUDIO_TOLERANCE_SAMPLES + 120)) * 2, "the overlapping head was trimmed");
    assert.deepEqual(adjustments, [ gap, -480, -(RAW_AUDIO_TOLERANCE_SAMPLES + 120) ]);
  });
});

// The pump.

describe("createRawPump", () => {

  test("writes paced yuv420p frames and aligned audio, and ends both pipes when the capture ends", async () => {

    const video = makeSink();
    const audio = makeSink();
    const pump = createRawPump({ audioOut: audio.sink, frameRate: 30, height: 2, videoOut: video.sink, width: 4 });
    const interval = 1000000 / 30;

    const error = await drive(pump, [

      // Audio ahead of the first frame is dropped.
      audioMessage(0, 480, 0.1),
      videoMessage(10000, 1),
      audioMessage(10000, 480, 0.2),
      videoMessage(10000 + interval, 2),

      // Two slots missed: frame 2 is repeated twice before frame 3.
      videoMessage(10000 + (4 * interval), 3)
    ]);

    assert.equal(error, undefined);
    assert.deepEqual(video.chunks.map((frame) => frame[0]), [ 1, 2, 2, 2, 3 ], "frames in slot order, gaps filled by repeating the previous frame");
    assert.ok(video.chunks.every((frame) => frame.length === 12), "every frame is a whole yuv420p frame");
    assert.equal(Buffer.concat(audio.chunks).length, 480 * 2 * 4, "only the aligned audio was written");
    assert.deepEqual(pump.stats, { audioSamplesPadded: 0, audioSamplesTrimmed: 0, framesDropped: 0, framesRejected: 0, framesRepeated: 2, framesWritten: 5,
      stalls: 0 });
    assert.ok(video.ended() && audio.ended(), "both pipes ended with the capture");
  });

  test("skips frames of the wrong size or format and counts them", async () => {

    const video = makeSink();
    const audio = makeSink();
    const pump = createRawPump({ audioOut: audio.sink, frameRate: 30, height: 2, videoOut: video.sink, width: 4 });

    await drive(pump, [ videoMessage(0, 1, 8, 2), frameMessage(RAW_KIND_VIDEO, 0, 0, 4, 2, Buffer.alloc(12)), videoMessage(0, 7) ]);

    assert.deepEqual(video.chunks.map((frame) => frame[0]), [7], "only the frame the pipe can take was written");
    assert.equal(pump.stats.framesRejected, 2);
  });

  test("fails on broken framing", async () => {

    const pump = createRawPump({ audioOut: makeSink().sink, frameRate: 30, height: 2, videoOut: makeSink().sink, width: 4 });
    const broken = Buffer.alloc(RAW_HEADER_SIZE);

    broken.writeUInt32LE(1, 0);

    const error = await drive(pump, [broken]);

    assert.match(error?.message ?? "", /framing is broken/);
  });

  test("fails when the encoder falls too far behind", async () => {

    // A pipe that never drains: every write stays buffered.
    const stuck = new Writable({ highWaterMark: 1, write: (): void => { /* Never calls back. */ } });
    const pump = createRawPump({ audioOut: makeSink().sink, frameRate: 30, height: 2, maxBufferedBytes: 20, videoOut: stuck, width: 4 });

    const error = await drive(pump, [ videoMessage(0, 1), videoMessage(33333, 2) ]);

    assert.match(error?.message ?? "", /fell behind/);
  });
});

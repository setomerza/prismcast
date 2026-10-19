/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * setup.encoderMode.test.ts: Tests for the FFmpeg encoder mode in createPageWithCapture and the plan that selects it.
 *
 * The mode changes three things about an establishment and nothing else: the capture asks the extension for the raw recorder, the FFmpeg spawned is the encoder
 * (with its audio pipe) rather than the remuxer, and the capture is piped into the pacing pump rather than into FFmpeg. These rows drive the real
 * createPageWithCapture on the static branch, as setup.ffmpegWiring.test.ts does, with the capture options and both spawns recorded, so each row reads which path
 * an establishment took, what the encoder was asked for, and that a host without the encoder falls back to the default path rather than failing the stream.
 */
import type { Browser, Page } from "puppeteer-core";
import type { CaptureStream, CaptureStreamOptions } from "../browser/tabCapture.ts";
import type { EncoderFFmpegOptions, EncoderFFmpegProcess, FFmpegProcess } from "../utils/index.ts";
import { RAW_HEADER_SIZE, RAW_KIND_VIDEO, RAW_PIXEL_FORMATS } from "../browser/rawCapture.ts";
import { beforeEach, describe, test } from "node:test";
import { createPageWithCapture, resolveEncoderPlan } from "./setup.ts";
import type { CreatePageWithCaptureDeps } from "./setup.ts";
import { LOG } from "../utils/index.ts";
import { PassThrough } from "node:stream";
import type { StreamSettings } from "../config/streamSettings.ts";
import assert from "node:assert/strict";
import { closePuppeteerStreamWssOnIdle } from "../testing.helpers.ts";
import { makeFakeFFmpeg } from "../utils/ffmpeg.helpers.ts";
import { makeProfile } from "../config/profiles.helpers.ts";
import { makeStreamSettings } from "../config/streamSettings.helpers.ts";

// Schedule background-server cleanup on a 0ms unref'd timer that fires when the suite resolves so the runner can exit cleanly.
closePuppeteerStreamWssOnIdle();

// The binary the encoder search answers in the rows where it finds one.
const ENCODER_BINARY = "/test/encoder/ffmpeg";

// What the current row's establishment did.
let acquiredOptions: CaptureStreamOptions[];
let captureStream: PassThrough;
let encoderSpawns: { bin: string; options: EncoderFFmpegOptions }[];
let encoderProcess: EncoderFFmpegProcess & { kills: () => number };
let faults: Error[];
let remuxSpawns: number;
let searches: string[];
let searchAnswer: string | undefined;

const deps: CreatePageWithCaptureDeps = {

  acquireCaptureStream: async (_page: Page, options: CaptureStreamOptions): Promise<CaptureStream> => {

    acquiredOptions.push(options);
    captureStream = new PassThrough();

    return captureStream as unknown as CaptureStream;
  },
  awaitCaptureVerdict: async (): Promise<null> => null,
  emulateCaptureSurface: async (): Promise<{ height: number; width: number }> => ({ height: 2, width: 4 }),
  getCurrentBrowser: async (): Promise<Browser> => ({ connected: false } as unknown as Browser),
  installActivationHeal: async (): Promise<void> => { /* Nothing to enrol on a stub page. */ },
  openSharedWindowTab: async (): Promise<Page> => ({

    close: async (): Promise<void> => { /* Nothing to close on a stub. */ },
    evaluateOnNewDocument: async (): Promise<void> => { /* No real document on a stub. */ },
    goto: async (): Promise<void> => { /* The static branch navigates once. */ },
    isClosed: (): boolean => false,
    setBypassCSP: async (): Promise<void> => { /* Nothing to bypass on a stub. */ }
  } as unknown as Page),
  reaffirmCaptureSurface: async (): Promise<void> => { /* No compositor on a stub. */ },
  resolveEncoderFFmpegPath: async (encoder: string): Promise<string | undefined> => {

    searches.push(encoder);

    return searchAnswer;
  },
  resolveFFmpegPath: async (): Promise<string> => "/test/remux/ffmpeg",
  spawnEncoderFFmpeg: (bin: string, options: EncoderFFmpegOptions): EncoderFFmpegProcess => {

    encoderSpawns.push({ bin, options });

    return encoderProcess;
  },
  spawnFFmpeg: (): FFmpegProcess => {

    remuxSpawns++;

    return makeFakeFFmpeg();
  },
  startOverlayHandling: async (): Promise<void> => { /* No overlays on a stub page. */ },
  syncWindowVisibility: async (): Promise<void> => { /* No window to settle. */ }
};

/**
 * Establishes a capture through the real createPageWithCapture on the static branch.
 * @param settings - The stream's settings.
 * @returns The disposer of the established capture session.
 */
async function establish(settings: StreamSettings): Promise<() => void> {

  const result = await createPageWithCapture({

    onFFmpegError: (error: Error): void => { faults.push(error); },
    profile: makeProfile({ staticCapture: true }),
    settings,
    skipManifestInterception: true,
    streamId: "encoder-mode-test",
    url: "https://static.example/page"
  }, deps);

  return (): void => { result.captureSession.dispose(); };
}

/**
 * Builds one raw I420 frame message for a 4x2 surface.
 * @param marker - The luma fill.
 * @returns The framed message.
 */
function rawFrame(marker: number): Buffer {

  const payload = Buffer.alloc(12, 128).fill(marker, 0, 8);
  const header = Buffer.alloc(RAW_HEADER_SIZE);

  header.writeUInt32LE(RAW_HEADER_SIZE + payload.length, 0);
  header.writeUInt8(RAW_KIND_VIDEO, 4);
  header.writeUInt8(RAW_PIXEL_FORMATS["I420"]!, 5);
  header.writeDoubleLE(0, 8);
  header.writeUInt32LE(4, 16);
  header.writeUInt32LE(2, 20);

  return Buffer.concat([ header, payload ]);
}

beforeEach(() => {

  acquiredOptions = [];
  encoderSpawns = [];
  encoderProcess = { ...makeFakeFFmpeg(), audioIn: new PassThrough() };
  faults = [];
  remuxSpawns = 0;
  searchAnswer = ENCODER_BINARY;
  searches = [];
});

describe("createPageWithCapture: the FFmpeg encoder mode", () => {

  test("the browser encoder runs the default path and never searches for an encoder", async () => {

    const dispose = await establish(makeStreamSettings());

    assert.equal(acquiredOptions[0]?.recorder, undefined, "the capture runs the extension's own recorder");
    assert.ok(!("recorder" in (acquiredOptions[0] ?? {})), "and the options carry no recorder key at all, as before the mode existed");
    assert.equal(remuxSpawns, 1, "the remuxer was spawned");
    assert.equal(encoderSpawns.length, 0, "the encoder was not");
    assert.deepEqual(searches, [], "no encoder search ran");

    dispose();
  });

  test("the ffmpeg encoder asks for raw capture, spawns the encoder with the stream's values, and pumps frames into it", async () => {

    const settings = makeStreamSettings({ audioBitsPerSecond: 128000, ffmpegVideoEncoder: "h264_nvenc", frameRate: 30, segmentDuration: 2, videoBitsPerSecond: 6000000,
      videoEncoder: "ffmpeg" });
    const dispose = await establish(settings);

    assert.equal(acquiredOptions[0]?.recorder, "raw", "the capture runs the raw recorder");
    assert.equal(remuxSpawns, 0, "no remuxer was spawned");
    assert.deepEqual(encoderSpawns, [{

      bin: ENCODER_BINARY,
      options: { audioBitrate: 128000, comment: undefined, encoder: "h264_nvenc", frameRate: 30, height: 2, keyframeInterval: 60, videoBitrate: 6000000, width: 4 }
    }], "the encoder runs the found binary at the surface's size, the stream's rates, and a keyframe per segment");

    const written: Buffer[] = [];

    encoderProcess.stdin.on("data", (chunk: Buffer) => { written.push(chunk); });
    captureStream.write(rawFrame(7));

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(written.length, 1, "the capture's frame reached the encoder's stdin through the pump");
    assert.equal(written[0]?.[0], 7, "as a yuv420p frame");

    dispose();
  });

  test("a host without the encoder falls back to the browser encoder", async () => {

    searchAnswer = undefined;

    const dispose = await establish(makeStreamSettings({ ffmpegVideoEncoder: "libx264", videoEncoder: "ffmpeg" }));

    assert.deepEqual(searches, ["libx264"], "the search ran for the configured encoder");
    assert.ok(!("recorder" in (acquiredOptions[0] ?? {})), "the capture fell back to the extension's own recorder");
    assert.equal(remuxSpawns, 1, "and the remuxer");

    dispose();
  });

  test("an encoder input error after teardown is not reported, and one on a live pipeline is reported once", async () => {

    const dispose = await establish(makeStreamSettings({ videoEncoder: "ffmpeg" }));

    encoderProcess.audioIn.emit("error", new Error("Unexpected input fault."));

    assert.equal(faults.length, 1, "a live fault is reported");
    assert.equal(encoderProcess.kills(), 1, "and the encoder is killed");

    encoderProcess.stdin.emit("error", new Error("Another fault, after the kill."));

    assert.equal(faults.length, 1, "a fault on a torn-down encoder is not reported again");

    dispose();
  });
});

describe("resolveEncoderPlan", () => {

  test("names no plan for the browser encoder and a plan for an encoder the search finds", async () => {

    const found = async (): Promise<string> => ENCODER_BINARY;

    assert.equal(await resolveEncoderPlan(makeStreamSettings({ videoEncoder: "browser" }), found), null);
    assert.deepEqual(await resolveEncoderPlan(makeStreamSettings({ ffmpegVideoEncoder: "h264_nvenc", videoEncoder: "ffmpeg" }), found),
      { encoder: "h264_nvenc", ffmpegBin: ENCODER_BINARY });
  });

  test("falls back for an encoder the mode does not drive, without searching, and warns once per encoder", async (t) => {

    const warn = t.mock.method(LOG, "warn", () => { /* Captured via the mock. */ });
    let searched = 0;
    const search = async (): Promise<string> => {

      searched++;

      return ENCODER_BINARY;
    };
    const settings = makeStreamSettings({ ffmpegVideoEncoder: "unknown_test_encoder", videoEncoder: "ffmpeg" });

    assert.equal(await resolveEncoderPlan(settings, search), null);
    assert.equal(await resolveEncoderPlan(settings, search), null);
    assert.equal(searched, 0, "an encoder the mode cannot drive is never searched for");
    assert.equal(warn.mock.callCount(), 1, "the fallback is reported once, not per tune");
  });
});

/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * setup.encoderMode.test.ts: Tests for the FFmpeg encoder mode in createPageWithCapture and the plan that selects it.
 *
 * The mode changes four things about an establishment and nothing else: the page is a capture window of its own rather than a tab of the shared window, the
 * capture asks the extension for the raw audio recorder, the FFmpeg spawned is the encoder - grabbing the window's rectangle of the screen, with its audio pipe -
 * rather than the remuxer, and the capture is piped into the audio pump rather than into FFmpeg. These rows drive the real createPageWithCapture on the static
 * branch, as setup.ffmpegWiring.test.ts does, with the page opened, the capture options, and both spawns recorded, so each row reads which path an establishment
 * took, what the encoder was asked for, and that a stream with no encoder or no window falls back to the default path rather than failing.
 */
import type { Browser, Page } from "puppeteer-core";
import type { CaptureStream, CaptureStreamOptions } from "../browser/tabCapture.ts";
import type { EncoderFFmpegOptions, EncoderFFmpegProcess, FFmpegProcess } from "../utils/index.ts";
import { beforeEach, describe, test } from "node:test";
import { createPageWithCapture, resolveEncoderPlan, withoutNativeFullscreen } from "./setup.ts";
import type { CaptureWindow } from "../browser/captureWindows.ts";
import type { CreatePageWithCaptureDeps } from "./setup.ts";
import { EventEmitter } from "node:events";
import { LOG } from "../utils/index.ts";
import { PassThrough } from "node:stream";
import { RAW_HEADER_SIZE } from "../browser/rawCapture.ts";
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

// The rectangle the stub capture window's content occupies.
const WINDOW_RECT = { height: 720, width: 1280, x: 1297, y: 90 };

// What the current row's establishment did.
let acquiredOptions: CaptureStreamOptions[];
let captureStream: PassThrough;
let encoderSpawns: { bin: string; options: EncoderFFmpegOptions }[];
let encoderProcess: EncoderFFmpegProcess & { kills: () => number };
let faults: Error[];
let openedPages: string[];
let releases: number;
let remuxSpawns: number;
let searches: string[];
let searchAnswer: string | undefined;
let windowAnswer: "none" | "open" | "throws";

/**
 * Builds a stub page for the static-capture pipeline, tagged so a row can tell which opener produced it.
 * @param tag - Which opener produced the page.
 * @returns The page.
 */
function makeStubPage(tag: string): Page {

  const emitter = new EventEmitter();

  openedPages.push(tag);

  return {

    close: async (): Promise<void> => { emitter.emit("close"); },
    evaluateOnNewDocument: async (): Promise<void> => { /* No real document on a stub. */ },
    goto: async (): Promise<void> => { /* The static branch navigates once. */ },
    isClosed: (): boolean => false,
    once: (event: string, listener: () => void): unknown => emitter.once(event, listener),
    setBypassCSP: async (): Promise<void> => { /* Nothing to bypass on a stub. */ }
  } as unknown as Page;
}

const deps: CreatePageWithCaptureDeps = {

  acquireCaptureStream: async (_page: Page, options: CaptureStreamOptions): Promise<CaptureStream> => {

    acquiredOptions.push(options);
    captureStream = new PassThrough();

    return captureStream as unknown as CaptureStream;
  },
  awaitCaptureVerdict: async (): Promise<null> => null,
  emulateCaptureSurface: async (): Promise<{ height: number; width: number }> => ({ height: 720, width: 1280 }),
  getCurrentBrowser: async (): Promise<Browser> => ({ connected: false } as unknown as Browser),
  installActivationHeal: async (): Promise<void> => { /* Nothing to enrol on a stub page. */ },
  openCaptureWindow: async (): Promise<CaptureWindow | null> => {

    if(windowAnswer === "throws") {

      throw new Error("The window could not be opened.");
    }

    return (windowAnswer === "open") ? { page: makeStubPage("window"), rect: WINDOW_RECT, release: (): void => { releases++; } } : null;
  },
  openSharedWindowTab: async (): Promise<Page> => makeStubPage("tab"),
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
 * @returns The disposer of the established capture session and page.
 */
async function establish(settings: StreamSettings): Promise<() => Promise<void>> {

  const result = await createPageWithCapture({

    onFFmpegError: (error: Error): void => { faults.push(error); },
    profile: makeProfile({ staticCapture: true }),
    settings,
    skipManifestInterception: true,
    streamId: "encoder-mode-test",
    url: "https://static.example/page"
  }, deps);

  return async (): Promise<void> => {

    result.captureSession.dispose();
    await result.page.close();
  };
}

/**
 * Builds one raw audio message: stereo 48 kHz, constant samples.
 * @param frames - Frames per channel.
 * @returns The framed message.
 */
function rawAudio(frames: number): Buffer {

  const payload = Buffer.alloc(frames * 2 * 4);
  const header = Buffer.alloc(RAW_HEADER_SIZE);

  payload.fill(0);
  header.writeUInt32LE(RAW_HEADER_SIZE + payload.length, 0);
  header.writeUInt8(2, 4);
  header.writeUInt8(2, 5);
  header.writeDoubleLE(0, 8);
  header.writeUInt32LE(48000, 16);
  header.writeUInt32LE(frames, 20);

  return Buffer.concat([ header, payload ]);
}

beforeEach(() => {

  acquiredOptions = [];
  encoderSpawns = [];
  encoderProcess = { ...makeFakeFFmpeg(), audioIn: new PassThrough() };
  faults = [];
  openedPages = [];
  releases = 0;
  remuxSpawns = 0;
  searchAnswer = ENCODER_BINARY;
  searches = [];
  windowAnswer = "open";
});

describe("createPageWithCapture: the FFmpeg encoder mode", () => {

  test("the browser encoder runs the default path: a shared-window tab, the extension's recorder, the remuxer", async () => {

    const dispose = await establish(makeStreamSettings());

    assert.deepEqual(openedPages, ["tab"], "the page is a tab of the shared window");
    assert.ok(!("recorder" in (acquiredOptions[0] ?? {})), "the options carry no recorder key at all, as before the mode existed");
    assert.equal(remuxSpawns, 1, "the remuxer was spawned");
    assert.equal(encoderSpawns.length, 0, "the encoder was not");
    assert.deepEqual(searches, [], "no encoder search ran");

    await dispose();
  });

  test("the ffmpeg encoder opens a capture window, captures audio raw, and grabs the window's rectangle", async () => {

    const settings = makeStreamSettings({ audioBitsPerSecond: 128000, ffmpegVideoEncoder: "h264_nvenc", frameRate: 30, segmentDuration: 2, videoBitsPerSecond: 6000000,
      videoEncoder: "ffmpeg" });
    const dispose = await establish(settings);

    assert.deepEqual(openedPages, ["window"], "the page is a capture window of its own");
    assert.equal(acquiredOptions[0]?.recorder, "raw", "the capture runs the raw audio recorder");
    assert.equal(remuxSpawns, 0, "no remuxer was spawned");
    assert.deepEqual(encoderSpawns, [{

      bin: ENCODER_BINARY,
      options: { audioBitrate: 128000, comment: undefined, encoder: "h264_nvenc", frameRate: 30, grab: { display: process.env["DISPLAY"] ?? ":99", x: 1297, y: 90 },
        height: 720, keyframeInterval: 60, videoBitrate: 6000000, width: 1280 }
    }], "the encoder grabs the window's content rectangle at the stream's rates, with a keyframe per segment");

    const written: Buffer[] = [];

    encoderProcess.audioIn.on("data", (chunk: Buffer) => { written.push(chunk); });
    captureStream.write(rawAudio(480));

    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(written.length > 0, "the capture's audio reached the encoder's audio pipe through the pump");

    await dispose();

    assert.equal(releases, 1, "closing the page returned the window's cell");
  });

  test("a host without the encoder falls back to the browser encoder without opening a window", async () => {

    searchAnswer = undefined;

    const dispose = await establish(makeStreamSettings({ ffmpegVideoEncoder: "libx264", videoEncoder: "ffmpeg" }));

    assert.deepEqual(searches, ["libx264"], "the search ran for the configured encoder");
    assert.deepEqual(openedPages, ["tab"], "no capture window was opened");
    assert.equal(remuxSpawns, 1, "and the remuxer runs");

    await dispose();
  });

  test("a stream that gets no capture window, or whose window fails to open, falls back to the browser encoder", async (t) => {

    t.mock.method(LOG, "warn", () => { /* Captured via the mock. */ });

    for(const answer of [ "none", "throws" ] as const) {

      windowAnswer = answer;
      openedPages = [];
      remuxSpawns = 0;

      // eslint-disable-next-line no-await-in-loop -- The two answers are established one after the other.
      const dispose = await establish(makeStreamSettings({ videoEncoder: "ffmpeg" }));

      assert.deepEqual(openedPages, ["tab"], answer + ": the page is a shared-window tab");
      assert.ok(!("recorder" in (acquiredOptions.at(-1) ?? {})), answer + ": the extension's own recorder runs");
      assert.equal(remuxSpawns, 1, answer + ": the remuxer runs");

      // eslint-disable-next-line no-await-in-loop -- Each establishment is torn down before the next.
      await dispose();
    }
  });

  test("an encoder input error after teardown is not reported, and one on a live pipeline is reported once", async () => {

    const dispose = await establish(makeStreamSettings({ videoEncoder: "ffmpeg" }));

    encoderProcess.audioIn.emit("error", new Error("Unexpected input fault."));

    assert.equal(faults.length, 1, "a live fault is reported");
    assert.equal(encoderProcess.kills(), 1, "and the encoder is killed");

    encoderProcess.audioIn.emit("error", new Error("Another fault, after the kill."));

    assert.equal(faults.length, 1, "a fault on a torn-down encoder is not reported again");

    await dispose();
  });
});

describe("withoutNativeFullscreen", () => {

  test("turns off the fullscreen key, button, and API and leaves the rest of the profile alone", () => {

    const profile = makeProfile({ fullscreenKey: "f", fullscreenSelector: ".fs", staticCapture: true, useRequestFullscreen: true });
    const grabbed = withoutNativeFullscreen(profile);

    assert.deepEqual([ grabbed.fullscreenKey, grabbed.fullscreenSelector, grabbed.useRequestFullscreen ], [ null, null, false ]);
    assert.equal(grabbed.staticCapture, true);
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

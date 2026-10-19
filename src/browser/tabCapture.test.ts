/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * tabCapture.test.ts: Unit tests for PrismCast's own capture acquisition. The module speaks the capture extension's protocol directly, so what is asserted here is
 * that protocol as a sequence of observable acts: a socket handler registered before the extension is invoked, one tab selection taken ahead of the activeTab
 * keyboard command and released after the start, and a settings object whose fields are exactly the ones the extension destructures.
 *
 * Everything is faked in this file rather than mocked at the loader, following the convention the bespoke page doubles in browser/tuning use: an EventEmitter
 * standing in for the WebSocket server, an emitter-backed socket, an extension page whose evaluate dispatches on the source text of the callback it is handed, a
 * page that records its keyboard traffic, and a tab-selection primitive that records the hold it takes rather than talking to a browser. Two rows reach outside
 * those fakes on purpose - the fingerprint and settings-shape assertions read the installed library through import.meta.resolve, because the coupling this module takes
 * on is only safe while the source it was written against is the source that is installed.
 */
import { ACTIVE_TAB_GRANT_CEILING_MS, ACTIVE_TAB_GRANT_POLL_MS, CAPTURE_FRAME_SIZE_MS, CAPTURE_STREAM_HIGH_WATER_MARK, EXTENSION_NOT_READY_MESSAGE,
  EXTENSION_READY_EXPRESSION, acquireCaptureStream } from "./tabCapture.ts";
import type { Browser, Page } from "puppeteer-core";
import type { CaptureStreamOptions, ExtensionRecordingSettings, TabCaptureDeps } from "./tabCapture.ts";
import { RAW_CAPTURE_MAX_BUFFERED_BYTES, RAW_HEADER_SIZE, RAW_KIND_AUDIO, RAW_KIND_VIDEO, RAW_PIXEL_FORMATS } from "./rawCapture.ts";
import type { SelectedTab, WithTabSelectedContext } from "./tabSelection.ts";
import { TestClock, advanceThroughSchedule, drainClock, settle } from "homebridge-plugin-utils/testing";
import type { WebSocket, WebSocketServer } from "ws";
import { describe, test } from "node:test";
import { CAPTURE_SOURCE_UNAVAILABLE_MESSAGE } from "../types/index.ts";
import { EventEmitter } from "node:events";
import type { LogEntry } from "../utils/logEmitter.ts";
import type { RawRecordingSettings } from "./rawCapture.ts";
import { TAB_NOT_SELECTED_MESSAGE } from "./tabSelection.ts";
import assert from "node:assert/strict";
import { closePuppeteerStreamWssOnIdle } from "../testing.helpers.ts";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { subscribeToLogs } from "../utils/logEmitter.ts";

// This file imports the module that imports puppeteer-stream, which spawns a WebSocketServer at load and would otherwise hold the runner open.
closePuppeteerStreamWssOnIdle();

// The capture options every row asks for, unless it needs a different shape. The constraint numbers are incidental here - what matters is that they arrive at the
// extension unchanged.
const OPTIONS: CaptureStreamOptions = {

  audio: true,
  audioBitsPerSecond: 128000,
  mimeType: "video/mp4;codecs=avc1,mp4a.40.2",
  video: true,
  videoBitsPerSecond: 8000000,
  videoConstraints: {

    mandatory: { maxFrameRate: 60, maxHeight: 1080, maxWidth: 1920, minFrameRate: 30, minHeight: 1080, minWidth: 1920 }
  }
};

// One evaluate the extension page served, tagged by which of the protocol calls it was.
interface ExtensionCall {

  arg: unknown;
  kind: "rawStart" | "rawStop" | "ready" | "start" | "stop" | "tabs";
}

// The socket double: an emitter the test drives, plus the flags the production code reads or sets.
interface FakeSocket {

  closeCalls: number;
  emitClose: () => void;
  emitMessage: (data: string) => void;
  socket: WebSocket;
}

// The server double: a real EventEmitter underneath, so registration, removal, and listener counting behave exactly as the ws server's do.
interface FakeServer {

  emitConnection: (socket: FakeSocket, index: number) => void;
  listeners: () => number;
  server: WebSocketServer;
}

// The extension page double, with the record of every protocol call it served and the shared ordering record its deps write into.
interface FakeExtension {

  calls: ExtensionCall[];
  disconnect: () => void;
  page: Page;
  timeline: string[];
}

// The capture page double, with the keyboard traffic it recorded and the close handler it was given.
interface FakePage {

  emitClose: () => void;
  page: Page;
}

/**
 * Builds the socket double.
 * @param timeline - The shared ordering record.
 * @returns The socket double.
 */
function makeFakeSocket(timeline: string[]): FakeSocket {

  const emitter = new EventEmitter();

  const handle: FakeSocket = {

    closeCalls: 0,
    emitClose: (): void => { emitter.emit("close"); },
    emitMessage: (data: string): void => { emitter.emit("message", Buffer.from(data)); },
    socket: {

      close: (): void => {

        handle.closeCalls++;
        timeline.push("socket:close");
      },
      on: (event: string, listener: (...args: unknown[]) => void): unknown => emitter.on(event, listener)
    } as unknown as WebSocket
  };

  return handle;
}

/**
 * Builds the server double over a real EventEmitter, so listener registration, removal, and counting are the genuine article rather than a tally.
 * @param timeline - The shared ordering record.
 * @returns The server double.
 */
function makeFakeServer(timeline: string[]): FakeServer {

  const emitter = new EventEmitter();

  const server = {

    listenerCount: (event: string): number => emitter.listenerCount(event),
    off: (event: string, listener: (...args: unknown[]) => void): unknown => {

      timeline.push("handler:off");

      return emitter.off(event, listener);
    },
    on: (event: string, listener: (...args: unknown[]) => void): unknown => {

      timeline.push("handler:on");

      return emitter.on(event, listener);
    }
  } as unknown as WebSocketServer;

  return {

    emitConnection: (socket: FakeSocket, index: number): void => {

      emitter.emit("connection", socket.socket, { url: "/?index=" + String(index) });
    },
    listeners: (): number => emitter.listenerCount("connection"),
    server
  };
}

/**
 * Builds the extension-page double. Its evaluate dispatches on the source text of what it is handed, which is how one double serves all four protocol calls
 * without the production code needing a test-only branch.
 * @param timeline - The shared ordering record.
 * @param options - The scripted answers.
 * @param options.onStart - What START_RECORDING does, given the settings and the one-based attempt number. Defaults to resolving.
 * @param options.ready - What the readiness expression answers. Defaults to true.
 * @param options.tabs - What the tab query answers. Defaults to one tab.
 * @returns The extension double.
 */
function makeFakeExtension(timeline: string[], options: { onStart?: (settings: ExtensionRecordingSettings, attempt: number) => Promise<void>; ready?: boolean;
  tabs?: { id?: number; url?: string }[]; } = {}): FakeExtension {

  const calls: ExtensionCall[] = [];

  let connected = true;
  let starts = 0;

  const evaluate = async (target: unknown, arg?: unknown): Promise<unknown> => {

    const source = String(target);

    if(source === EXTENSION_READY_EXPRESSION) {

      calls.push({ arg, kind: "ready" });
      timeline.push("ready");

      return options.ready ?? true;
    }

    // The raw recorder's functions are matched by name first, since their bodies mention the extension's own protocol in comments.
    if(source.includes("function startRawRecording")) {

      starts++;
      calls.push({ arg, kind: "rawStart" });
      timeline.push("start");

      return options.onStart?.(arg as ExtensionRecordingSettings, starts);
    }

    if(source.includes("function stopRawRecording")) {

      calls.push({ arg, kind: "rawStop" });
      timeline.push("stop");

      return undefined;
    }

    if(source.includes("START_RECORDING")) {

      starts++;
      calls.push({ arg, kind: "start" });
      timeline.push("start");

      return options.onStart?.(arg as ExtensionRecordingSettings, starts);
    }

    if(source.includes("STOP_RECORDING")) {

      calls.push({ arg, kind: "stop" });
      timeline.push("stop");

      return undefined;
    }

    if(source.includes("chrome.tabs.query")) {

      calls.push({ arg, kind: "tabs" });
      timeline.push("tabs");

      return options.tabs ?? [{ id: 42, url: "https://example.test/live" }];
    }

    throw new Error("Unserved evaluate shape: " + source.slice(0, 160));
  };

  return {

    calls,
    disconnect: (): void => { connected = false; },
    page: {

      browser: (): Browser => ({ connected } as unknown as Browser),
      evaluate,
      isClosed: (): boolean => false
    } as unknown as Page,
    timeline
  };
}

/**
 * Builds the capture-page double, recording the keyboard traffic the activeTab grant is made of.
 * @param timeline - The shared ordering record.
 * @returns The page double.
 */
function makeFakePage(timeline: string[]): FakePage {

  const emitter = new EventEmitter();

  return {

    emitClose: (): void => { emitter.emit("close"); },
    page: {

      browser: (): Browser => ({ connected: true } as unknown as Browser),

      /* The refusal's diagnostic reads the window's state through this page, so the double answers the two commands that read takes. Both answers are the
       * ordinary ones: a resolvable window that reports itself presented.
       */
      createCDPSession: async (): Promise<unknown> => ({

        send: async (method: string): Promise<unknown> => {

          if(method === "Browser.getWindowForTarget") {

            return { windowId: 7 };
          }

          return { bounds: { windowState: "normal" } };
        }
      }),
      isClosed: (): boolean => false,
      keyboard: {

        down: async (key: string): Promise<void> => { timeline.push("down:" + key); },
        press: async (key: string): Promise<void> => { timeline.push("press:" + key); },
        up: async (key: string): Promise<void> => { timeline.push("up:" + key); }
      },
      once: (event: string, listener: () => void): unknown => emitter.once(event, listener)
    } as unknown as Page
  };
}

/**
 * Runs a body with every emitted log entry captured, and hands back the warnings among them.
 * @param body - The work to run under capture.
 * @returns The warn-level entries emitted while the body ran.
 */
async function captureWarnings(body: () => Promise<void>): Promise<LogEntry[]> {

  const captured: LogEntry[] = [];
  const unsubscribe = subscribeToLogs((entry) => { captured.push(entry); });

  try {

    await body();
  } finally {

    unsubscribe();
  }

  return captured.filter((entry) => entry.level === "warn");
}

/**
 * Composes the deps an acquisition runs against.
 *
 * The selection primitive is a fake rather than the real one: this file asserts what the ACQUISITION does inside a hold, while tabSelection.test.ts asserts what a hold
 * itself does. It records the hold's two boundaries and every re-assert into the shared timeline, so a row can assert that exactly one selection spans a poll of
 * several attempts, and hands the body a tab whose url the refusal diagnostics are expected to carry.
 * @param extension - The extension double.
 * @param server - The server double.
 * @param onSelect - Behavior to run in place of taking the selection, for the rows where the selection itself fails. Resolves silently by default.
 * @returns The deps.
 */
function makeDeps(extension: FakeExtension, server: FakeServer, onSelect?: () => Promise<void>): TabCaptureDeps {

  const timeline = extension.timeline;

  // The two resolutions of the ws types (this file's and the library declaration's) are structurally the same server with different nominal identities, so the
  // fake is handed over through the same cast every page double in the suite uses.
  return {

    getExtensionPage: async (): Promise<Page> => extension.page,
    withTabSelected: async <T>(_page: Page, body: (tab: SelectedTab) => Promise<T>, _context?: WithTabSelectedContext): Promise<T> => {

      await onSelect?.();

      timeline.push("select");

      const selected: SelectedTab = {

        id: 42,
        reassert: async (): Promise<void> => { timeline.push("reassert"); },
        url: "https://example.test/live",
        windowId: 1
      };

      try {

        return await body(selected);
      } finally {

        timeline.push("release");
      }
    },
    wss: Promise.resolve(server.server) as unknown as TabCaptureDeps["wss"]
  };
}

describe("acquireCaptureStream", () => {

  test("registers the socket handler before invoking the extension, and holds one tab selection around the grant and the start", async () => {

    /* The order is the protocol, not a preference. START_RECORDING opens its socket before it asks Chrome for the capture, so a handler registered afterwards
     * misses the connection outright. Chrome records whichever tab is selected, so the selection has to be taken before the keyboard command that grants the
     * extension activeTab for it, held across the start, and handed back after - the release at the end of the log is the user getting their tab back. The
     * selection opens the log because one hold spans the whole grant poll, and each attempt inside it prepares its own socket handler.
     */
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    await acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });

    assert.deepEqual(timeline,
      [ "ready", "select", "handler:on", "reassert", "down:Meta", "down:Shift", "press:KeyY", "up:Shift", "up:Meta", "start", "release" ],
      "readiness, then the selection, the attempt's handler and its re-assert, the grant keys in order, the start, and only then the give-back");
    assert.ok(timeline.indexOf("handler:on") < timeline.indexOf("start"), "the socket handler is registered before the extension is ever invoked");

    const start = extension.calls.find((call) => call.kind === "start");

    assert.deepEqual(start?.arg, {

      audio: true,
      audioBitsPerSecond: 128000,
      frameSize: CAPTURE_FRAME_SIZE_MS,
      index: (start?.arg as ExtensionRecordingSettings).index,
      mimeType: "video/mp4;codecs=avc1,mp4a.40.2",
      tabId: 42,
      video: true,
      videoBitsPerSecond: 8000000,
      videoConstraints: OPTIONS.videoConstraints
    }, "the settings the extension receives are exactly the protocol's fields, with the caller's constraints carried through unchanged");
  });

  test("delivers the socket's messages in order, ignores another capture's socket, and ends on close", async () => {

    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();
    const before = server.listeners();
    const stream = await acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });
    const chunks: string[] = [];

    stream.on("data", (chunk: Buffer) => { chunks.push(chunk.toString()); });

    assert.equal(stream.readableHighWaterMark, CAPTURE_STREAM_HIGH_WATER_MARK, "the stream is sized to absorb Chrome's keyframe bursts");

    const index = (extension.calls.find((call) => call.kind === "start")?.arg as ExtensionRecordingSettings).index;

    // A socket announcing another capture's index belongs to another handler, so nothing of it reaches this stream.
    const stranger = makeFakeSocket(timeline);

    server.emitConnection(stranger, index + 1);
    stranger.emitMessage("not-ours");

    const socket = makeFakeSocket(timeline);

    server.emitConnection(socket, index);
    socket.emitMessage("first");
    socket.emitMessage("second");

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(chunks, [ "first", "second" ], "only this capture's messages arrive, in order");

    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Standard pattern for signal promises.
    const ended = Promise.withResolvers<void>();

    stream.once("end", () => { ended.resolve(); });

    socket.emitClose();

    await Promise.all([ ended.promise, stream.stopped ]);

    assert.equal(stream.readableEnded, true, "the socket's close ended the stream");
    assert.equal(server.listeners(), before, "the handler came off the server when the capture ended");
  });

  test("stop() asks the extension once across repeated calls and hands back the same promise every time", async () => {

    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();
    const stream = await acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });
    const first = stream.stop();
    const second = stream.stop();

    assert.equal(first, second, "every call resolves to the capture's own completion, not to the call's");

    await first;

    assert.equal(extension.calls.filter((call) => call.kind === "stop").length, 1, "the stop request goes out exactly once");
    assert.equal(server.listeners(), 0, "the handler came off the server");

    // A capture whose socket never connected has no close event coming, so its completion settles on the stop itself rather than waiting for one.
    await stream.stopped;
  });

  test("stop() on a disconnected browser resolves without asking the extension", async () => {

    // Negative test: the request has to reach a browser that is still listening. Evaluating against a dead one would reject inside a teardown that has nothing
    // useful to do with the rejection.
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();
    const stream = await acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });

    extension.disconnect();

    await stream.stop();

    assert.equal(extension.calls.filter((call) => call.kind === "stop").length, 0, "no stop request is sent to a browser that is gone");
  });

  test("the raw recorder starts through startRawRecording with the protocol's values, inside the same selection and grant", async () => {

    /* A raw capture differs from the default in what the extension is asked to run and nothing else: the selection, the attempt's handler, and the grant keys come
     * in the same order, and the settings carry the framing values the pump parses with, so the two sides cannot drift apart.
     */
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    await acquireCaptureStream(page.page, { ...OPTIONS, recorder: "raw" }, { clock, deps: makeDeps(extension, server) });

    // The grant's modifier is the platform's, so the expectation reads it the same way the grant does.
    const modifier = (process.platform === "darwin") ? "Meta" : "Control";

    assert.deepEqual(timeline,
      [ "ready", "select", "handler:on", "reassert", "down:" + modifier, "down:Shift", "press:KeyY", "up:Shift", "up:" + modifier, "start", "release" ],
      "the raw start runs in exactly the default start's place");
    assert.equal(extension.calls.filter((call) => call.kind === "start").length, 0, "the extension's MediaRecorder is never started");

    const start = extension.calls.find((call) => call.kind === "rawStart");

    assert.deepEqual(start?.arg, {

      audio: true,
      formatCodes: RAW_PIXEL_FORMATS,
      headerSize: RAW_HEADER_SIZE,
      index: (start?.arg as RawRecordingSettings).index,
      kinds: { audio: RAW_KIND_AUDIO, video: RAW_KIND_VIDEO },
      maxBufferedBytes: RAW_CAPTURE_MAX_BUFFERED_BYTES,
      video: true,
      videoConstraints: OPTIONS.videoConstraints
    }, "the raw settings carry the capture's shape and the framing constants");
  });

  test("stop() on a raw capture asks stopRawRecording, once, for its own index", async () => {

    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();
    const stream = await acquireCaptureStream(page.page, { ...OPTIONS, recorder: "raw" }, { clock, deps: makeDeps(extension, server) });

    await Promise.all([ stream.stop(), stream.stop() ]);

    const index = (extension.calls.find((call) => call.kind === "rawStart")?.arg as RawRecordingSettings).index;

    assert.deepEqual(extension.calls.filter((call) => call.kind === "rawStop").map((call) => call.arg), [index], "one raw stop, for the capture's own index");
    assert.equal(extension.calls.filter((call) => call.kind === "stop").length, 0, "the extension's own stop is not asked for a recording it never ran");
  });

  test("a source-unavailable refusal fails after a single start and logs the window and tab state", async () => {

    /* The refusal arrives as a bare string, which is how puppeteer delivers a page-side rejection that is not an Error - classifying on .message would miss it
     * entirely. One start is made and its refusal is this acquisition's verdict, carried to the caller unchanged; what the refusal means about the browser is
     * settled a layer up, by the establishment's probe. The two state fields the warning carries are read inside the hold, while the capture's tab was still the
     * selected one, so the tab in the log is the tab the refused start was aimed at rather than whatever was selected by the time the warning was written.
     */
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const before = server.listeners();
    const extension = makeFakeExtension(timeline, {

      onStart: async (): Promise<void> => {

        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Chrome's rejection arrives as a bare string, which is exactly what is under test.
        throw CAPTURE_SOURCE_UNAVAILABLE_MESSAGE;
      }
    });
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    const warnings = await captureWarnings(async () => {

      await assert.rejects(acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) }),
        (error: unknown) => (error instanceof Error) && error.message.includes(CAPTURE_SOURCE_UNAVAILABLE_MESSAGE),
        "the bare-string refusal reaches the caller as an Error carrying Chrome's text");
    });

    assert.equal(extension.calls.filter((call) => call.kind === "start").length, 1, "exactly one start is made for the refusal");
    assert.equal(warnings.length, 1, "exactly one warning");
    assert.match(warnings[0]?.message ?? "", /Chrome refused to start the tab capture/, "the warning names the refusal");
    assert.match(warnings[0]?.message ?? "", /windowState: 'normal'/, "the warning carries the window state Chrome reported at the moment of the refusal");
    assert.match(warnings[0]?.message ?? "", /activeTab: 'https:\/\/example.test\/live'/, "and the tab the capture was aimed at");
    assert.equal(server.listeners(), before, "the refused attempt left no handler on the server");
  });

  test("any other refusal fails after a single attempt, with no warning", async () => {

    // Negative test: the refusal line exists for one specific answer from Chrome, whose diagnostics live nowhere else. Logging it for every failure would put a
    // warning in front of the collision the capture lock exists to prevent, which is not a refusal at all.
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline, {

      onStart: async (): Promise<void> => {

        throw new Error("Cannot capture a tab with an active stream");
      }
    });
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    let warnings: LogEntry[] = [];

    warnings = await captureWarnings(async () => {

      await assert.rejects(acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) }),
        (error: unknown) => (error instanceof Error) && (error.message === "Cannot capture a tab with an active stream"),
        "the rejection travels unchanged");
    });

    assert.equal(extension.calls.filter((call) => call.kind === "start").length, 1, "exactly one attempt");
    assert.equal(warnings.length, 0, "no warning for a failure that carries no refusal diagnostics");
  });

  test("waits out a pending activeTab grant by re-attempting on the cadence, each on a fresh index", async () => {

    /* The keyboard command that grants activeTab is asynchronous, so Chrome can answer the first start with "has not been invoked for the current page". That
     * answer is a signal to ask again, and asking is strictly better than sleeping: a grant already in place costs one attempt and no wait at all.
     */
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const before = server.listeners();
    const extension = makeFakeExtension(timeline, {

      onStart: async (_settings, attempt): Promise<void> => {

        if(attempt < 3) {

          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Chrome's rejection arrives as a bare string.
          throw "Extension has not been invoked for the current page (see activeTab permission)";
        }
      }
    });
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    const running = acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });

    await settle();
    assert.equal(clock.pending, 1, "the first attempt found no grant, so its cadence is parked on the clock");

    await advanceThroughSchedule(clock, [ ACTIVE_TAB_GRANT_POLL_MS, ACTIVE_TAB_GRANT_POLL_MS ]);
    await running;

    const starts = extension.calls.filter((call) => call.kind === "start");
    const indexes = starts.map((call) => (call.arg as ExtensionRecordingSettings).index);

    assert.equal(starts.length, 3, "the start is re-attempted until the grant lands");
    assert.equal(new Set(indexes).size, 3, "every attempt publishes under its own index");
    assert.deepEqual(clock.requested, [ ACTIVE_TAB_GRANT_POLL_MS, ACTIVE_TAB_GRANT_POLL_MS ], "one cadence wait between each pair of attempts");
    assert.equal(server.listeners(), before + 1, "only the successful attempt's handler survives");
  });

  test("gives up on a grant that never lands and reports Chrome's own answer", async () => {

    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const before = server.listeners();
    const extension = makeFakeExtension(timeline, {

      onStart: async (): Promise<void> => {

        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Chrome's rejection arrives as a bare string.
        throw "Extension has not been invoked for the current page (see activeTab permission)";
      }
    });
    const page = makeFakePage(timeline);
    const clock = new TestClock();
    const running = acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });

    // The expectation is attached before the clock is driven, so the rejection the drain releases is observed rather than left unhandled.
    const rejection = assert.rejects(running, (error: unknown) => (error instanceof Error) && error.message.includes("has not been invoked for the current page"),
      "the last grant-pending answer is what the caller sees");

    await settle();
    assert.equal(clock.pending, 1, "the first attempt found no grant, so its cadence is parked on the clock");

    await drainClock(clock);
    await rejection;

    assert.equal(clock.now(), ACTIVE_TAB_GRANT_CEILING_MS, "virtual time advanced by exactly the cadences the ceiling afforded");
    assert.equal(extension.calls.filter((call) => call.kind === "start").length, Math.floor(ACTIVE_TAB_GRANT_CEILING_MS / ACTIVE_TAB_GRANT_POLL_MS) + 1,
      "the ceiling affords one attempt plus one per cadence");
    assert.equal(server.listeners(), before, "no attempt left a handler behind");
  });

  test("destroying the stream stops the recording, and so does the page dying", async () => {

    // Both endings have to reach the extension: the owner's disposer destroys the stream, and a page that dies takes its capture with it. Neither can be left to
    // the socket handler, because a capture whose socket never connected would then never stop.
    const destroyTimeline: string[] = [];
    const destroyServer = makeFakeServer(destroyTimeline);
    const destroyExtension = makeFakeExtension(destroyTimeline);
    const destroyPage = makeFakePage(destroyTimeline);
    const destroyClock = new TestClock();
    const destroyed = await acquireCaptureStream(destroyPage.page, OPTIONS, { clock: destroyClock, deps: makeDeps(destroyExtension, destroyServer) });

    destroyed.destroy();

    await destroyed.stopped;

    assert.equal(destroyExtension.calls.filter((call) => call.kind === "stop").length, 1, "destroying the stream stopped the recording");

    const closeTimeline: string[] = [];
    const closeServer = makeFakeServer(closeTimeline);
    const closeExtension = makeFakeExtension(closeTimeline);
    const closePage = makeFakePage(closeTimeline);
    const closeClock = new TestClock();
    const closed = await acquireCaptureStream(closePage.page, OPTIONS, { clock: closeClock, deps: makeDeps(closeExtension, closeServer) });

    closePage.emitClose();

    await closed.stopped;

    assert.equal(closeExtension.calls.filter((call) => call.kind === "stop").length, 1, "the page's death stopped the recording");
  });

  test("rejects before preparing anything when the extension is not ready", async () => {

    // Negative test: the launch gate establishes readiness before a browser is published, so reaching this means the extension went away underneath one. Nothing
    // should be prepared or sent on that path.
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline, { ready: false });
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    await assert.rejects(acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) }),
      (error: unknown) => (error instanceof Error) && (error.message === EXTENSION_NOT_READY_MESSAGE));

    assert.deepEqual(timeline, ["ready"], "nothing was registered and no key was sent");
    assert.equal(server.listeners(), 0, "no handler was ever registered");
  });

  test("a selection that fails fails the acquisition and leaves no attempt behind", async () => {

    /* Chrome records whichever tab is selected, so a selection the extension could not take leaves nothing to point the recorder at. The failure has to travel
     * before any attempt is prepared - a listener or a socket index spent on a start that cannot happen would outlive the acquisition that gave up.
     */
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline);
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    const deps = makeDeps(extension, server, async (): Promise<void> => { throw new Error(TAB_NOT_SELECTED_MESSAGE); });

    await assert.rejects(acquireCaptureStream(page.page, OPTIONS, { clock, deps }),
      (error: unknown) => (error instanceof Error) && (error.message === TAB_NOT_SELECTED_MESSAGE), "the selection's own message is the acquisition's verdict");

    assert.equal(extension.calls.filter((call) => call.kind === "start").length, 0, "no start was attempted");
    assert.equal(server.listeners(), 0, "no handler was left registered");
  });

  test("a grant-pending poll of several attempts runs inside ONE selection, re-asserting it per attempt", async () => {

    /* The selection is taken once for the whole poll rather than per attempt: taking it per attempt would hand the user's tab back and take it again between
     * refusals, and the flicker would be theirs to watch. Each attempt still re-asserts before it acts, so a login page opening or a click landing between two
     * attempts is corrected rather than recorded. Exactly one select and one release bracket the whole log, with a re-assert opening each attempt.
     */
    const timeline: string[] = [];
    const server = makeFakeServer(timeline);
    const extension = makeFakeExtension(timeline, {

      onStart: async (_settings, attempt): Promise<void> => {

        if(attempt === 1) {

          // eslint-disable-next-line @typescript-eslint/only-throw-error -- Chrome's rejection arrives as a bare string.
          throw "Extension has not been invoked for the current page (see activeTab permission)";
        }
      }
    });
    const page = makeFakePage(timeline);
    const clock = new TestClock();

    const running = acquireCaptureStream(page.page, OPTIONS, { clock, deps: makeDeps(extension, server) });

    await settle();
    assert.equal(clock.pending, 1, "the first attempt found no grant, so its cadence is parked on the clock");

    await advanceThroughSchedule(clock, [ACTIVE_TAB_GRANT_POLL_MS]);
    await running;

    assert.equal(timeline.filter((entry) => entry === "select").length, 1, "one selection covers the whole poll");
    assert.equal(timeline.filter((entry) => entry === "release").length, 1, "and it is handed back exactly once");
    assert.equal(timeline.filter((entry) => entry === "reassert").length, 2, "each of the two attempts re-asserts the selection first");
    assert.ok(timeline.indexOf("select") < timeline.findIndex((entry) => entry === "reassert"), "the selection precedes the first attempt's re-assert");
    assert.equal(timeline[timeline.length - 1], "release", "the give-back closes the log, after the start that succeeded");
    assert.equal(timeline.lastIndexOf("start"), timeline.length - 2, "with the successful start immediately before it");
  });

});

/* The coupling assertions. This module was written against a specific version of the library and its extension, and the protocol it speaks lives in files that a
 * dependency bump can change silently. These two rows read the INSTALLED files rather than a copy, so a bump fails here with instructions instead of failing a
 * capture in the field.
 */
describe("the locked capture-extension protocol", () => {

  /**
   * Resolves a path inside the installed puppeteer-stream package.
   * @param relative - The path relative to the package root.
   * @returns The absolute path.
   */
  const libraryPath = (relative: string): string => path.join(path.dirname(fileURLToPath(import.meta.resolve("puppeteer-stream/package.json"))), relative);

  test("the library files this module speaks to are the ones it was written against", async () => {

    const fingerprints: Record<string, string> = {

      "dist/PuppeteerStream.js": "3dcc89ee5f3aa4ccc9180d670948b5eff49500e2b288889d81c19b8accbee2f7",
      "extension/manifest.json": "979bbad603000ff3dd5ec0159b198db6cab91f7dfa904e133e357c48010095b2",
      "extension/options.js": "243d332ecb333a9db13dc184cd97660b74f20186c172ce6b171c1db457f81ebf"
    };

    for(const [ relative, expected ] of Object.entries(fingerprints)) {

      // eslint-disable-next-line no-await-in-loop -- Three small reads; the sequence keeps the failure message pointing at one file.
      const actual = createHash("sha256").update(await readFile(libraryPath(relative))).digest("hex");

      assert.equal(actual, expected, "puppeteer-stream's " + relative + " has changed. Re-read extension/options.ts and dist/PuppeteerStream.js, re-verify " +
        "tabCapture.ts against them, and only then update this fingerprint.");
    }

    const manifest = JSON.parse(await readFile(libraryPath("package.json"), "utf8")) as { version: string };

    assert.equal(manifest.version, "3.0.23", "the locked library version moved; re-verify the protocol before updating this assertion");
  });

  test("the settings object carries exactly the fields the extension destructures", async () => {

    /* The extension's own source is the oracle. Listing the keys through a Record keyed on the interface makes the compiler insist every field is accounted for,
     * and comparing that list against the names parsed out of the extension's RecordingOptions catches a field added or removed upstream.
     */
    const settingKeys: Record<keyof ExtensionRecordingSettings, true> = {

      audio: true,
      audioBitsPerSecond: true,
      audioConstraints: true,
      bitsPerSecond: true,
      delay: true,
      frameSize: true,
      index: true,
      mimeType: true,
      tabId: true,
      video: true,
      videoBitsPerSecond: true,
      videoConstraints: true
    };

    const source = await readFile(libraryPath("extension/options.ts"), "utf8");
    const block = (/export type RecordingOptions = \{([\s\S]*?)\};/).exec(source);

    assert.ok(block?.[1], "the extension's RecordingOptions declaration could not be found; the protocol's shape cannot be verified");

    const declared = Array.from(block[1].matchAll(/^\s*(\w+)\??:/gm)).map((match) => match[1] ?? "").sort();

    assert.deepEqual(declared, Object.keys(settingKeys).sort(), "the extension's settings shape and this module's mirror of it have diverged");
  });
});

/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * captureWindows.test.ts: Tests for the FFmpeg encoder mode's per-stream capture windows: the grid the screen is laid out in, the pool that hands its cells out,
 * the frame geometry that parks a window's content at a known rectangle, and the window opening itself, driven with a stub browser and page so no Chrome runs.
 */
import type { Browser, Page } from "puppeteer-core";
import { CAPTURE_CELL_FRAME_ALLOWANCE, createCaptureCellPool, getCaptureCellPool, layoutCaptureCells, measureInsets, openCaptureWindow, placeInCell,
  readScreenSize } from "./captureWindows.ts";
import type { CaptureWindowDeps, WindowFrame, WindowMetrics } from "./captureWindows.ts";
import { describe, test } from "node:test";
import { LOG } from "../utils/index.ts";
import assert from "node:assert/strict";

const CONTENT = { height: 720, width: 1280 };
const PITCH = { height: CONTENT.height + CAPTURE_CELL_FRAME_ALLOWANCE.height, width: CONTENT.width + CAPTURE_CELL_FRAME_ALLOWANCE.width };

describe("layoutCaptureCells", () => {

  test("lays out whole cells of content plus frame allowance, row by row, leaving cell 0 to the shared window", () => {

    const cells = layoutCaptureCells({ height: 3 * PITCH.height, width: (3 * PITCH.width) + 10 }, CONTENT);

    assert.equal(cells.length, 8, "a 3x3 grid less the shared window's cell");
    assert.deepEqual(cells[0], { index: 1, x: PITCH.width, y: 0 }, "the first capture cell is the second of the top row");
    assert.deepEqual(cells[2], { index: 3, x: 0, y: PITCH.height }, "the next row starts at the left edge");
    assert.deepEqual(cells.at(-1), { index: 8, x: 2 * PITCH.width, y: 2 * PITCH.height });
  });

  test("a screen that holds only the shared window's cell has no capture cells", () => {

    assert.deepEqual(layoutCaptureCells({ height: 1080, width: 1920 }, CONTENT), []);
  });
});

describe("createCaptureCellPool", () => {

  test("hands out the lowest free cell, reports what is free, and takes cells back", () => {

    const pool = createCaptureCellPool(layoutCaptureCells({ height: PITCH.height, width: 3 * PITCH.width }, CONTENT));
    const first = pool.allocate();
    const second = pool.allocate();

    assert.deepEqual([ first?.index, second?.index ], [ 1, 2 ]);
    assert.equal(pool.allocate(), null, "an exhausted pool answers null");
    assert.equal(pool.free(), 0);

    pool.release(first!);
    pool.release(first!);

    assert.equal(pool.free(), 1, "a double release frees the cell once");
    assert.equal(pool.allocate()?.index, 1, "the freed cell is the next one handed out");
  });
});

describe("getCaptureCellPool", () => {

  test("warns once when the grid holds fewer windows than the stream limit plus one, and reuses the pool for the same content size", (t) => {

    const warn = t.mock.method(LOG, "warn", () => { /* Captured via the mock. */ });
    const content = { height: 360, width: 640 };
    const screen = { height: 1080, width: 1920 };
    const pool = getCaptureCellPool(content, 10, screen);

    assert.equal(warn.mock.callCount(), 1, "five capture cells cannot hold ten streams and a replacement");
    assert.equal(getCaptureCellPool(content, 10, screen), pool, "the same pool comes back");
    assert.equal(warn.mock.callCount(), 1, "and the warning is not repeated");
  });
});

describe("readScreenSize", () => {

  test("reads the entrypoint's variables and falls back to its default", () => {

    assert.deepEqual(readScreenSize({ SCREEN_HEIGHT: "2640", SCREEN_WIDTH: "3968" }), { height: 2640, width: 3968 });
    assert.deepEqual(readScreenSize({}), { height: 1080, width: 1920 });
    assert.deepEqual(readScreenSize({ SCREEN_HEIGHT: "zero", SCREEN_WIDTH: "-5" }), { height: 1080, width: 1920 });
  });
});

describe("measureInsets and placeInCell", () => {

  test("puts the frame Chrome draws above the content and a thin border elsewhere", () => {

    assert.deepEqual(measureInsets({ innerHeight: 720, innerWidth: 1280, outerHeight: 811, outerWidth: 1282 }), { bottom: 1, left: 1, right: 1, top: 90 });
    assert.deepEqual(measureInsets({ innerHeight: 720, innerWidth: 1280, outerHeight: 800, outerWidth: 1280 }), { bottom: 0, left: 0, right: 0, top: 80 });
  });

  test("parks the frame at the cell's origin with the content at the size asked for, offset by the insets", () => {

    const placement = placeInCell({ index: 4, x: 1296, y: 880 }, CONTENT, { bottom: 1, left: 1, right: 1, top: 90 });

    assert.deepEqual(placement, {

      frame: { height: 811, left: 1296, top: 880, width: 1282 },
      rect: { height: 720, width: 1280, x: 1297, y: 970 }
    });
  });

  test("refuses a frame larger than the cell's allowance", () => {

    assert.equal(placeInCell({ index: 1, x: 0, y: 0 }, CONTENT, { bottom: 0, left: 0, right: 0, top: CAPTURE_CELL_FRAME_ALLOWANCE.height + 1 }), null);
  });
});

describe("openCaptureWindow", () => {

  /**
   * Builds a stub browser whose one page reports the given metrics before and after parking.
   * @param before - The metrics before parking.
   * @param after - The metrics after parking.
   * @returns The browser, the page's record, and the deps the window is opened with.
   */
  function makeRig(before: WindowMetrics, after: WindowMetrics, setFrameAnswer = true): {
    browser: Browser; deps: CaptureWindowDeps; frames: WindowFrame[]; record: { closed: boolean; focused: boolean; marked: boolean; options: unknown };
  } {

    const record = { closed: false, focused: false, marked: false, options: undefined as unknown };
    const frames: WindowFrame[] = [];
    let reads = 0;

    const page = {

      close: async (): Promise<void> => { record.closed = true; },
      emulateFocusedPage: async (): Promise<void> => { record.focused = true; },
      evaluate: async (): Promise<WindowMetrics> => ((reads++ === 0) ? before : after)
    } as unknown as Page;

    const browser = {

      newPage: async (options: unknown): Promise<Page> => {

        record.options = options;

        return page;
      }
    } as unknown as Browser;

    const deps: CaptureWindowDeps = {

      markOwnWindowPage: (): void => { record.marked = true; },
      setWindowFrame: async (_page: Page, frame: WindowFrame): Promise<boolean> => {

        frames.push(frame);

        return setFrameAnswer;
      }
    };

    return { browser, deps, frames, record };
  }

  const exact = { innerHeight: 720, innerWidth: 1280, outerHeight: 811, outerWidth: 1282 };

  test("opens a marked, focus-emulated background window and parks its content at the cell's rectangle", async () => {

    const pool = createCaptureCellPool([{ index: 1, x: 1296, y: 0 }]);
    const { browser, deps, frames, record } = makeRig({ innerHeight: 629, innerWidth: 1278, outerHeight: 720, outerWidth: 1280 }, exact);
    const capture = await openCaptureWindow(browser, pool, CONTENT, deps);

    assert.deepEqual(record.options, { background: true, type: "window", windowBounds: { height: 720, left: 1296, top: 0, width: 1280 } });
    assert.ok(record.marked && record.focused, "the page was marked as its own window and focus-emulated");
    assert.deepEqual(frames, [{ height: 811, left: 1296, top: 0, width: 1282 }], "the frame grew to fit the content exactly");
    assert.deepEqual(capture?.rect, { height: 720, width: 1280, x: 1297, y: 90 }, "the grab region is the content area");
    assert.equal(pool.free(), 0, "the cell is in use");
    assert.ok(capture, "the window was opened");

    capture.release();
    capture.release();

    assert.equal(pool.free(), 1, "and released once");
  });

  test("answers null without opening anything when no cell is free", async () => {

    const pool = createCaptureCellPool([]);
    const { browser, deps, record } = makeRig(exact, exact);

    assert.equal(await openCaptureWindow(browser, pool, CONTENT, deps), null);
    assert.equal(record.options, undefined, "no window was opened");
  });

  test("closes the window and frees the cell when it cannot be parked", async (t) => {

    t.mock.method(LOG, "warn", () => { /* Captured via the mock. */ });

    const pool = createCaptureCellPool([{ index: 1, x: 0, y: 0 }]);
    const { browser, deps, record } = makeRig(exact, exact, false);

    assert.equal(await openCaptureWindow(browser, pool, CONTENT, deps), null);
    assert.ok(record.closed, "the window was closed");
    assert.equal(pool.free(), 1, "and its cell freed");
  });

  test("warns when the content area is not the asked size after parking, but still returns the window", async (t) => {

    const warn = t.mock.method(LOG, "warn", () => { /* Captured via the mock. */ });
    const pool = createCaptureCellPool([{ index: 1, x: 0, y: 0 }]);
    const { browser, deps } = makeRig(exact, { ...exact, innerHeight: 700 });

    assert.ok(await openCaptureWindow(browser, pool, CONTENT, deps));
    assert.equal(warn.mock.callCount(), 1);
  });
});

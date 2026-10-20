/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * captureWindows.ts: Per-stream capture windows for the FFmpeg encoder mode.
 *
 * In the default mode every capture is a tab of the one shared window and Chrome's tab capture records it even while it is a background tab. The FFmpeg encoder
 * mode grabs each stream's video straight off the X display instead (x11grab), and a screen grab only sees what is on the screen, so each such stream gets a
 * Chrome window of its own, parked at a fixed rectangle no other capture window overlaps, with its content area exactly the stream's capture size.
 *
 * The screen is laid out as a grid of cells. A cell is the content size plus an allowance for the window's own frame (the tab strip and toolbar Chrome draws
 * above the content, and any border), so a window parked at its cell's origin keeps its frame inside the cell and its content clear of every neighbour. Cell 0,
 * at the screen's origin, is never handed out: it is left to the shared window, whose resting tab, sign-ins, and discovery windows live there. The container
 * runs no window manager, so a window lands exactly where it is put and nothing raises or rearranges it.
 *
 * A capture window is created in the background, so it moves no focus, and is focus-emulated for its whole life, so Chrome presents its document and keeps
 * rendering it - without that, a background window reports itself hidden and stops delivering frames, and the grab would record a still (the same treatment
 * createDiscoveryPage gives a discovery window, for the same reason). It is marked as a window of its own before anything is awaited, so it is never taken
 * for a shared-window carrier and the visibility policy never minimizes it.
 */
import type { Browser, Page } from "puppeteer-core";
import { LOG } from "../utils/index.ts";
import type { Nullable } from "../types/index.ts";
import { markOwnWindowPage } from "./index.ts";
import { setWindowFrame } from "./cdp.ts";

// Constants.

// What a cell allows around its content for the window's frame. Chrome draws its own frame when no window manager does: a tab strip and a toolbar above the
// content, and at most a thin border elsewhere. A window whose measured frame exceeds this cannot be parked without overlapping a neighbour and is refused.
export const CAPTURE_CELL_FRAME_ALLOWANCE = { height: 160, width: 16 } as const;

// The screen size assumed when the environment does not state one, which is the container entrypoint's own default.
const DEFAULT_SCREEN = { height: 1080, width: 1920 } as const;

// Types.

/**
 * A width and a height in screen pixels.
 */
export interface Size {

  readonly height: number;
  readonly width: number;
}

/**
 * One cell of the capture grid: its index and its origin, where the window's frame starts.
 */
export interface CaptureCell {

  readonly index: number;
  readonly x: number;
  readonly y: number;
}

/**
 * How far a window's content area sits inside its frame on each side.
 */
export interface WindowInsets {

  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
}

/**
 * The sizes a page reports for its window and its content area.
 */
export interface WindowMetrics {

  readonly innerHeight: number;
  readonly innerWidth: number;
  readonly outerHeight: number;
  readonly outerWidth: number;
}

/**
 * A window's outer frame in screen coordinates, as Browser.setWindowBounds takes it.
 */
export interface WindowFrame {

  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

/**
 * A rectangle of the screen: the region an x11grab of a capture window reads.
 */
export interface ScreenRect {

  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The cells of a grid, handed out one at a time.
 */
export interface CaptureCellPool {

  // Takes the lowest free cell, or null when every cell is in use.
  allocate: () => Nullable<CaptureCell>;

  // The number of cells not in use.
  free: () => number;

  // Returns a cell to the pool. Returning a cell that is not in use is a no-op.
  release: (cell: CaptureCell) => void;
}

/**
 * A capture window: its page, the screen region its content occupies, and the release that returns its cell.
 */
export interface CaptureWindow {

  readonly page: Page;
  readonly rect: ScreenRect;

  // Returns the window's cell to the pool. Safe to call more than once. Closing the page is the caller's, as for every capture page.
  release: () => void;
}

/**
 * The browser-touching collaborators of openCaptureWindow, injected so a test can drive it without Chrome.
 */
export interface CaptureWindowDeps {

  readonly markOwnWindowPage: typeof markOwnWindowPage;
  readonly setWindowFrame: typeof setWindowFrame;
}

const defaultCaptureWindowDeps: CaptureWindowDeps = { markOwnWindowPage, setWindowFrame };

// Layout.

/**
 * Lays the screen out as a grid of cells for a content size, leaving out cell 0, which belongs to the shared window.
 * @param screen - The X screen's size.
 * @param content - The capture content size, the quality preset's viewport.
 * @returns The cells capture windows may use, in index order.
 */
export function layoutCaptureCells(screen: Size, content: Size): CaptureCell[] {

  const pitchWidth = content.width + CAPTURE_CELL_FRAME_ALLOWANCE.width;
  const pitchHeight = content.height + CAPTURE_CELL_FRAME_ALLOWANCE.height;
  const columns = Math.floor(screen.width / pitchWidth);
  const rows = Math.floor(screen.height / pitchHeight);
  const cells: CaptureCell[] = [];

  for(let row = 0; row < rows; row++) {

    for(let column = 0; column < columns; column++) {

      const index = (row * columns) + column;

      if(index > 0) {

        cells.push({ index, x: column * pitchWidth, y: row * pitchHeight });
      }
    }
  }

  return cells;
}

/**
 * Creates a pool over a set of cells.
 * @param cells - The cells the pool hands out.
 * @returns The pool.
 */
export function createCaptureCellPool(cells: readonly CaptureCell[]): CaptureCellPool {

  const inUse = new Set<number>();

  return {

    allocate: (): Nullable<CaptureCell> => {

      const cell = cells.find((candidate) => !inUse.has(candidate.index)) ?? null;

      if(cell) {

        inUse.add(cell.index);
      }

      return cell;
    },
    free: (): number => cells.length - inUse.size,
    release: (cell: CaptureCell): void => {

      inUse.delete(cell.index);
    }
  };
}

// The process's pool, built for the content size it was first asked for. The size is the quality preset's, which only changes with a restart.
let processPool: Nullable<{ content: Size; pool: CaptureCellPool }> = null;

/**
 * Returns the process's capture cell pool for a content size, laying the grid out on first use. When the screen holds fewer capture windows than the stream
 * limit plus one - a tab replacement briefly needs a second window for its stream - that is logged once, with what to raise: streams beyond the grid still play,
 * through the browser encoder.
 * @param content - The capture content size, the quality preset's viewport.
 * @param maxStreams - The configured stream limit.
 * @param screen - The X screen's size. Defaults to the size the environment states.
 * @returns The pool.
 */
export function getCaptureCellPool(content: Size, maxStreams: number, screen: Size = readScreenSize()): CaptureCellPool {

  if((processPool?.content.width === content.width) && (processPool.content.height === content.height)) {

    return processPool.pool;
  }

  const cells = layoutCaptureCells(screen, content);

  if(cells.length < (maxStreams + 1)) {

    LOG.warn("The %dx%d screen holds %d capture windows of %dx%d, fewer than the %d streams plus one replacement the stream limit allows; streams beyond that " +
      "use the browser encoder. Raise SCREEN_WIDTH and SCREEN_HEIGHT to fit more.", screen.width, screen.height, cells.length, content.width, content.height,
    maxStreams);
  }

  processPool = { content, pool: createCaptureCellPool(cells) };

  return processPool.pool;
}

/**
 * Reads the X screen's size from the environment the container entrypoint starts Xvfb with, falling back to the entrypoint's own default.
 * @param env - The environment to read. Defaults to the process environment.
 * @returns The screen size.
 */
export function readScreenSize(env: Readonly<Record<string, string | undefined>> = process.env): Size {

  const width = Number.parseInt(env["SCREEN_WIDTH"] ?? "", 10);
  const height = Number.parseInt(env["SCREEN_HEIGHT"] ?? "", 10);

  return {

    height: (Number.isFinite(height) && (height > 0)) ? height : DEFAULT_SCREEN.height,
    width: (Number.isFinite(width) && (width > 0)) ? width : DEFAULT_SCREEN.width
  };
}

// Geometry.

/**
 * Splits a window's frame into insets. The sizes alone say how much frame there is across and down, not where it sits, so the split assumes what Chrome draws
 * with no window manager: the horizontal frame divided evenly between the sides, and a bottom border as thick as a side, with everything else above the content.
 * The verification after the window is parked checks the result, and a mismatch is logged.
 * @param metrics - The page's outer and inner sizes.
 * @returns The insets.
 */
export function measureInsets(metrics: WindowMetrics): WindowInsets {

  const horizontal = Math.max(0, metrics.outerWidth - metrics.innerWidth);
  const vertical = Math.max(0, metrics.outerHeight - metrics.innerHeight);
  const left = Math.floor(horizontal / 2);
  const right = horizontal - left;
  const bottom = Math.min(left, vertical);

  return { bottom, left, right, top: vertical - bottom };
}

/**
 * Computes where a window goes so its content area is exactly the content size inside a cell, and where that content then sits on the screen.
 * @param cell - The cell.
 * @param content - The content size.
 * @param insets - The window's frame insets.
 * @returns The window's frame and its content rectangle, or null when the frame does not fit the cell's allowance.
 */
export function placeInCell(cell: CaptureCell, content: Size, insets: WindowInsets): Nullable<{ frame: WindowFrame; rect: ScreenRect }> {

  const frameWidth = insets.left + insets.right;
  const frameHeight = insets.top + insets.bottom;

  if((frameWidth > CAPTURE_CELL_FRAME_ALLOWANCE.width) || (frameHeight > CAPTURE_CELL_FRAME_ALLOWANCE.height)) {

    return null;
  }

  return {

    frame: { height: content.height + frameHeight, left: cell.x, top: cell.y, width: content.width + frameWidth },
    rect: { height: content.height, width: content.width, x: cell.x + insets.left, y: cell.y + insets.top }
  };
}

// Windows.

/**
 * Opens a capture window in a cell: a background window of its own, marked and focus-emulated, parked so its content area is exactly the content size at a
 * known screen rectangle. The page's metrics are read once to learn the frame and once more after parking to confirm the content size.
 * @param browser - The browser to open the window in.
 * @param pool - The pool the cell comes from and returns to.
 * @param content - The content size.
 * @param deps - The browser-touching collaborators. Defaults to the production ones.
 * @returns The capture window, or null when no cell is free or the window could not be parked; a window that could not be parked is closed again.
 */
export async function openCaptureWindow(browser: Browser, pool: CaptureCellPool, content: Size,
  deps: CaptureWindowDeps = defaultCaptureWindowDeps): Promise<Nullable<CaptureWindow>> {

  const cell = pool.allocate();

  if(!cell) {

    return null;
  }

  let released = false;

  const release = (): void => {

    if(!released) {

      released = true;
      pool.release(cell);
    }
  };

  // The window opens at its cell with the content size as a first guess at its frame; the measurement below corrects it.
  const page = await browser.newPage({ background: true, type: "window", windowBounds: { height: content.height, left: cell.x, top: cell.y, width: content.width } });

  // Marked with nothing awaited in between, so no read can take this page for a shared-window carrier.
  deps.markOwnWindowPage(page);

  try {

    await page.emulateFocusedPage(true);

    const readMetrics = async (): Promise<WindowMetrics> => page.evaluate(() => ({ innerHeight: window.innerHeight, innerWidth: window.innerWidth,
      outerHeight: window.outerHeight, outerWidth: window.outerWidth }));

    const insets = measureInsets(await readMetrics());
    const placement = placeInCell(cell, content, insets);

    if(!placement || !(await deps.setWindowFrame(page, placement.frame))) {

      LOG.warn("A capture window could not be parked in its cell (frame insets %o); this stream uses the browser encoder.", insets);
      await page.close();
      release();

      return null;
    }

    const parked = await readMetrics();

    if((parked.innerWidth !== content.width) || (parked.innerHeight !== content.height)) {

      LOG.warn("A capture window's content area is %dx%d rather than %dx%d after parking; the grab may include part of its frame.", parked.innerWidth,
        parked.innerHeight, content.width, content.height);
    }

    LOG.debug("browser:lifecycle", "Opened a capture window in cell %d, content at %d,%d (frame insets %o).", cell.index, placement.rect.x, placement.rect.y,
      insets);

    return { page, rect: placement.rect, release };
  } catch(error) {

    try {

      await page.close();
    } catch {

      // The page is already gone, which is the state the close was asking for.
    }

    release();

    throw error;
  }
}

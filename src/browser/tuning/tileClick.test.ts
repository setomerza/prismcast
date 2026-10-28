/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * tileClick.test.ts: Unit tests for the tile click strategy's verification on auto-play sites. A page can render its tile before its script handles a click, so the
 * strategy waits for a video element after the click and clicks the tile again when none appears. The page double answers the tile lookup with fixed
 * coordinates and records each mouse click; its one frame reports a video once the click count reaches the number the row sets, which is how a row states
 * "the first click was ignored" without a browser.
 */
import { describe, test } from "node:test";
import type { ChannelSelectionProfile } from "../../types/index.ts";
import assert from "node:assert/strict";
import { makeFakePage } from "../../testing.helpers.ts";
import { makeProfile } from "../../config/profiles.helpers.ts";
import { tileClickStrategy } from "./tileClick.ts";

// Where the double reports the tile.
const TILE = { x: 640, y: 360 };

/**
 * Runs the strategy against a page whose video appears after the given number of tile clicks.
 * @param clicksForVideo - How many clicks it takes for a video element to exist; Infinity for a page that never plays.
 * @returns The strategy's result and the clicks the page received.
 */
async function runTileClick(clicksForVideo: number): Promise<{ clicks: number; success: boolean }> {

  let clicks = 0;

  const frame = { $: async (): Promise<object | null> => ((clicks >= clicksForVideo) ? {} : null) };

  const fake = makeFakePage({

    frames: [frame],
    onEvaluate: (call) => { call.resolve(TILE); },
    onMouseClick: (call) => { clicks++; call.resolve(undefined); }
  });

  const profile: ChannelSelectionProfile = { ...makeProfile({ channelSelection: { matchSelector: "[data-network=\"{channel}\"]", strategy: "tileClick" } }),
    channelSelector: "413" };
  const result = await tileClickStrategy.execute(fake.page, profile);

  return { clicks, success: result.success };
}

describe("tileClick on an auto-play site", () => {

  test("clicks the tile once when the video appears", async () => {

    assert.deepEqual(await runTileClick(1), { clicks: 1, success: true });
  });

  test("clicks the tile again when the first click starts no video", async () => {

    assert.deepEqual(await runTileClick(2), { clicks: 2, success: true });
  });
});

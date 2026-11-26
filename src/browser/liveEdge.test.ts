/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * liveEdge.test.ts: Unit tests for the live-edge walk's decisions and its loop, driven by a fake player whose clock moves the way Netflix's did on 2026-11-25.
 */
import { BURST, PROBE, PROBE_GAP_MS, STUCK_LIMIT_MS, WALK_LIMIT_MS, nextStep, seekTookEffect, walkToLiveEdge } from "./liveEdge.ts";
import { describe, test } from "node:test";
import type { Frame, Page } from "puppeteer-core";
import assert from "node:assert/strict";

describe("seekTookEffect", () => {

  test("a burst that moved the clock by most of its seek took effect", () => {

    assert.equal(seekTookEffect(30, 300 + 4, 4), true);
  });

  test("a clock that only kept time did not", () => {

    assert.equal(seekTookEffect(30, 4, 4), false);
    assert.equal(seekTookEffect(3, 4, 4), false);
  });

  test("half the seek is enough: the live edge can cut a burst short", () => {

    assert.equal(seekTookEffect(3, 15 + 2, 2), true);
    assert.equal(seekTookEffect(3, 14 + 2, 2), false);
  });
});

describe("nextStep", () => {

  test("bursts while seeking works", () => {

    assert.equal(nextStep(true, 0, 1000), "burst");
  });

  test("probes while stuck, for longer than an ad break", () => {

    assert.equal(nextStep(false, 0, 1000), "probe");
    assert.equal(nextStep(false, STUCK_LIMIT_MS - PROBE_GAP_MS, 1000), "probe");
    assert.equal(nextStep(false, STUCK_LIMIT_MS, 1000), "done");
  });

  test("ends at the walk's limit", () => {

    assert.equal(nextStep(true, 0, WALK_LIMIT_MS), "done");
  });
});

// A player 30 minutes behind the live edge, with an ad of adSeconds starting after the first burst, during which presses do nothing.
function fakePlayer(behind: number, adSeconds: number): { context: Frame | Page; page: Page; presses: () => number; clock: { delay: (ms: number) => Promise<void>; now: () => number } } {

  let now = 0;
  let position = 0;
  let edge = behind;
  let presses = 0;
  let adUntil = -1;
  let bursts = 0;

  const advance = (ms: number): void => {

    now += ms;
    position += ms / 1000;
    edge += ms / 1000;
  };

  const clock = { delay: async (ms: number): Promise<void> => { advance(ms); }, now: (): number => now };
  const page = {

    isClosed: (): boolean => false,
    keyboard: {

      press: async (): Promise<void> => {

        presses++;

        if(now >= adUntil) {

          position = Math.min(edge, position + 10);
        }
      }
    }
  } as unknown as Page;
  const context = {

    evaluate: async (): Promise<number> => {

      // The first read after the first moving burst starts the ad.
      if((position > 30) && (bursts++ === 0) && (adSeconds > 0)) {

        adUntil = now + adSeconds * 1000;
      }

      return position;
    }
  } as unknown as Frame;

  return { clock, context, page, presses: (): number => presses };
}

describe("walkToLiveEdge", () => {

  test("reaches the live edge through an ad break and then stops", async () => {

    const player = fakePlayer(30 * 60, 150);

    await walkToLiveEdge(player.page, player.context, "selectReadyVideo", player.clock as never);

    // Every second of the 30 minutes was walked, and after the edge only probes were pressed.
    assert.ok(player.presses() >= 180);
    assert.ok(player.presses() <= 180 + (2 * BURST) + ((STUCK_LIMIT_MS / PROBE_GAP_MS) + 2) * PROBE * 2);
  });

  test("a tune already at the live edge only probes", async () => {

    const player = fakePlayer(0, 0);

    await walkToLiveEdge(player.page, player.context, "selectReadyVideo", player.clock as never);

    assert.ok(player.presses() <= ((STUCK_LIMIT_MS / PROBE_GAP_MS) + 1) * PROBE);
  });
});

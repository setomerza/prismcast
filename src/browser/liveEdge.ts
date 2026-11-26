/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * liveEdge.ts: Brings a live event's player up to the live edge after a tune, for sites that resume a live event where the account last stopped watching.
 *
 * Netflix opens a live title at the account's bookmark: on 2026-11-25 a tune at kickoff resumed the pre-game show from a test half an hour earlier, so viewers saw
 * the countdown while the game was on. The player has no "go live" key, but its right arrow seeks 10 seconds ahead and stops at the live edge, and it ignores the
 * key while an ad plays. So the walk presses the key in bursts and watches the video's clock: a burst that moved it keeps the walk going; one that did not is
 * either the live edge or an ad, and the walk then waits and probes with a few presses until a long enough stretch of probes has moved nothing.
 */
import type { Frame, KeyInput, Page } from "puppeteer-core";
import { LOG, evaluateWithAbort, formatError } from "../utils/index.ts";
import type { Clock } from "homebridge-plugin-utils";
import type { Nullable, VideoSelectorType } from "../types/index.ts";

// Seconds one key press seeks on the player.
export const SEEK_STEP = 10;

// Presses in a burst while seeking works, and in a probe while it does not.
export const BURST = 30;
export const PROBE = 3;

// Pause after a burst for the player to settle before its clock is read, and between probes while stuck.
export const SETTLE_MS = 2000;
export const PROBE_GAP_MS = 20000;

// How long probes must move nothing before the walk ends: longer than an ad break, which can hold the player back for up to about three minutes.
export const STUCK_LIMIT_MS = 200000;

// The walk ends after this long whatever happens.
export const WALK_LIMIT_MS = 30 * 60000;

// Time between key presses in a burst.
const PRESS_GAP_MS = 60;

/**
 * What a burst did: whether the player moved at least half the requested seek beyond the time that passed.
 *
 * @param presses - Key presses sent.
 * @param mediaDelta - Seconds the video's clock moved over the burst.
 * @param wallDelta - Seconds that passed over the burst.
 * @returns True when the seek took effect.
 */
export function seekTookEffect(presses: number, mediaDelta: number, wallDelta: number): boolean {

  return (mediaDelta - wallDelta) >= (presses * SEEK_STEP) / 2;
}

/**
 * The next step of the walk, from the state it is in.
 *
 * @param moved - Whether the last burst or probe took effect.
 * @param stuckMs - How long probes have moved nothing so far, before this one.
 * @param elapsedMs - How long the walk has run.
 * @returns "burst" to press a full burst at once, "probe" to wait and probe, or "done".
 */
export function nextStep(moved: boolean, stuckMs: number, elapsedMs: number): "burst" | "done" | "probe" {

  if(elapsedMs >= WALK_LIMIT_MS) {

    return "done";
  }

  if(moved) {

    return "burst";
  }

  return (stuckMs >= STUCK_LIMIT_MS) ? "done" : "probe";
}

async function readClock(context: Frame | Page, selectorType: VideoSelectorType): Promise<Nullable<number>> {

  return evaluateWithAbort(context, (type: string): Nullable<number> => {

    const video = window.__prismcastSelectVideo?.(type) ?? null;

    return video ? video.currentTime : null;
  }, [selectorType]);
}

/**
 * Walks the player up to the live edge. Runs in the background after a tune and never throws: a closed page or a failed read simply ends the walk.
 *
 * @param page - The tuned page, for key input.
 * @param context - The frame or page holding the video.
 * @param selectorType - The video selector type for finding the element.
 * @param clock - The clock the walk's pauses run on.
 * @param key - The key that seeks forward.
 */
export async function walkToLiveEdge(page: Page, context: Frame | Page, selectorType: VideoSelectorType, clock: Clock, key: KeyInput = "ArrowRight"): Promise<void> {

  const started = clock.now();
  let presses = PROBE;
  let stuckMs = 0;
  let seeked = 0;

  try {

    for(;;) {

      const before = await readClock(context, selectorType);
      const wallBefore = clock.now();

      if((before === null) || page.isClosed()) {

        return;
      }

      for(let i = 0; i < presses; i++) {

        // eslint-disable-next-line no-await-in-loop
        await page.keyboard.press(key);
        // eslint-disable-next-line no-await-in-loop
        await clock.delay(PRESS_GAP_MS);
      }

      await clock.delay(SETTLE_MS);

      const after = await readClock(context, selectorType);

      if(after === null) {

        return;
      }

      const moved = seekTookEffect(presses, after - before, (clock.now() - wallBefore) / 1000);

      if(moved) {

        seeked += after - before;
        stuckMs = 0;
      }

      const step = nextStep(moved, stuckMs, clock.now() - started);

      if(step === "done") {

        LOG.info("Live edge: moved %ss ahead in %ss.", Math.round(seeked), Math.round((clock.now() - started) / 1000));

        return;
      }

      if(step === "burst") {

        presses = BURST;

        continue;
      }

      presses = PROBE;
      stuckMs += PROBE_GAP_MS;
      // eslint-disable-next-line no-await-in-loop
      await clock.delay(PROBE_GAP_MS);
    }
  } catch(error) {

    LOG.debug("browser:video", "Live edge walk ended: %s.", formatError(error));
  }
}

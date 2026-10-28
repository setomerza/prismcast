/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * tileClick.ts: Tile click channel selection strategy for multi-channel live TV sites.
 */
import type { ChannelSelectionProfile, ChannelSelectorResult, ChannelStrategyEntry, ClickTarget, Nullable } from "../../types/index.ts";
import { LOG, evaluateWithAbort } from "../../utils/index.ts";
import { resolveMatchSelector, scrollAndClick } from "./shared.ts";
import { CONFIG } from "../../config/index.ts";
import type { Page } from "puppeteer-core";
import { systemClock } from "homebridge-plugin-utils";

// Maximum number of play button click attempts before giving up. The first click sometimes misses due to coordinate shifts from SPA animations or overlay
// interference - retrying with fresh coordinates resolves most transient failures.
const MAX_PLAY_CLICK_ATTEMPTS = 3;

// Timeout in milliseconds to wait for the play button to disappear after clicking it. This is the verification signal that the SPA transitioned to the player view.
// Kept short so retries happen quickly rather than burning the full videoTimeout on a silent miss.
const PLAY_CLICK_VERIFY_TIMEOUT = 3000;

// Maximum number of tile clicks on an auto-play site, and how long in milliseconds each click is given to put a video element on the page. A page can render its
// tile before its script is ready to handle a click: on a cold load DISH Anywhere's Watch Live button ignored the first click on every tune, and a second click
// four to five seconds in started the video within a second. The wait covers that, and a click that has worked is never repeated.
const MAX_TILE_CLICK_ATTEMPTS = 3;
const TILE_CLICK_VERIFY_TIMEOUT = 4000;

// How often, in milliseconds, the frames are checked for a video element while a tile click is being verified.
const VIDEO_POLL_INTERVAL = 250;

/**
 * Tile click strategy: finds a channel element using the profile's matchSelector (defaults to image URL matching), clicks the tile, and optionally clicks a play
 * button if the profile specifies one. This strategy works for multi-channel live TV sites that display channels as tiles in a horizontal shelf. When
 * `channelSelection.playSelector` is set (e.g., Disney+), clicking the tile opens a modal and the play button is clicked to start the stream. When `playSelector`
 * is absent, clicking the tile is the final action and the site auto-plays the selected channel.
 *
 * The selection process:
 * 1. Find channel elements matching the resolved matchSelector CSS selector
 * 2. Walk up the DOM from the first visible match to find the nearest clickable ancestor (the tile container)
 * 3. Scroll the tile into view and click it
 * 4. If `playSelector` is configured: wait for the play button, click it, and verify the modal dismissed - retrying up to 3 times on silent failures.
 *    Otherwise: verify the tile click by a video element appearing, clicking the tile again up to 3 times in all when none does
 * @param page - The Puppeteer page object.
 * @param profile - The resolved site profile with a non-null channelSelector.
 * @returns Result object with success status and optional failure reason.
 */
async function tileClickStrategyFn(page: Page, profile: ChannelSelectionProfile): Promise<ChannelSelectorResult> {

  const selector = resolveMatchSelector(profile);

  // Step 1: Find the channel tile.
  const tileTarget = await findTileTarget(page, selector);

  if(!tileTarget) {

    return { reason: "Channel element not found for selector.", success: false };
  }

  // Click the channel tile. For sites with a play button (playSelector configured), this opens a modal. For auto-play sites, this is the final action.
  await scrollAndClick(page, tileTarget);

  // Step 2 (conditional): If the profile specifies a play button selector, wait for it and click it. Sites like Disney+ show a modal with a "WATCH LIVE" button
  // after clicking the tile. Sites without playSelector auto-play on tile click: there the click is verified by a video element appearing instead.
  const playButtonSelector = profile.channelSelection.playSelector;

  if(!playButtonSelector) {

    await verifyAutoPlayClick(page, selector);

    return { success: true };
  }

  try {

    await page.waitForSelector(playButtonSelector, { timeout: CONFIG.streaming.videoTimeout });
  } catch {

    return { reason: "Play button did not appear after clicking channel tile.", success: false };
  }

  // Click the play button with retry. Coordinate-based clicks can silently miss due to SPA animations, overlay interference, or stale coordinates. We verify each
  // click by checking whether the play button disappears (indicating the modal dismissed and the SPA transitioned to the player). On failure, we re-read
  // coordinates and retry - the same pattern used by Sling's clickWithRetry.
  for(let attempt = 0; attempt < MAX_PLAY_CLICK_ATTEMPTS; attempt++) {

    // Get the play button coordinates. Re-read on every attempt because SPA animations or layout shifts may have moved the button since the last read.
    // eslint-disable-next-line no-await-in-loop
    const playTarget = await evaluateWithAbort(page, (selector: string): Nullable<ClickTarget> => {

      const button = document.querySelector(selector);

      if(!button) {

        return null;
      }

      (button as HTMLElement).scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

      const rect = button.getBoundingClientRect();

      if((rect.width > 0) && (rect.height > 0)) {

        return { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
      }

      return null;
    }, [playButtonSelector]);

    if(!playTarget) {

      // Play button no longer resolves to a clickable target between attempts - either it was removed (the previous click likely worked and the SPA
      // transitioned), or it is still present but reports no rendered size, which can happen when the verification timeout races against a slow modal
      // dismissal animation.
      if(attempt > 0) {

        LOG.debug("tuning:tileClick", "Play button disappeared before attempt %s. Previous click likely succeeded.", attempt + 1);

        return { success: true };
      }

      return { reason: "Play button found but has no dimensions.", success: false };
    }

    // Click the play button to start live playback.
    // eslint-disable-next-line no-await-in-loop
    await scrollAndClick(page, playTarget);

    // Verify the click worked by waiting for the play button to disappear. When the SPA transitions to the player view, the modal (and its play button) is removed
    // from the DOM. If the button is still present after the timeout, the click missed and we retry with fresh coordinates.
    try {

      // eslint-disable-next-line no-await-in-loop
      await page.waitForSelector(playButtonSelector, { hidden: true, timeout: PLAY_CLICK_VERIFY_TIMEOUT });

      return { success: true };
    } catch {

      // Play button still visible - the click had no effect. Log and retry.
      if(attempt < (MAX_PLAY_CLICK_ATTEMPTS - 1)) {

        LOG.info("Play button click attempt %s of %s did not dismiss the modal. Retrying with fresh coordinates.",
          attempt + 1, MAX_PLAY_CLICK_ATTEMPTS);
      }
    }
  }

  return { reason: "Play button click did not dismiss the modal after " + String(MAX_PLAY_CLICK_ATTEMPTS) + " attempts.", success: false };
}

/**
 * Finds the first visible element matching the selector and returns the center of its nearest clickable ancestor, the tile container.
 * @param page - The Puppeteer page object.
 * @param selector - The resolved matchSelector.
 * @returns The tile's click coordinates, or null when no visible match has a clickable ancestor.
 */
async function findTileTarget(page: Page, selector: string): Promise<Nullable<ClickTarget>> {

  // We find the first visible match, then walk up the DOM to find the nearest clickable ancestor that represents the entire tile.
  return evaluateWithAbort(page, (sel: string): Nullable<ClickTarget> => {

    const elements = document.querySelectorAll(sel);

    for(const el of Array.from(elements)) {

      const htmlEl = el as HTMLElement;
      const elRect = htmlEl.getBoundingClientRect();

      // Verify the element has dimensions (is actually rendered and visible). This provides defense-in-depth if the coordinator's wait phase timed out before the
      // element fully loaded.
      if((elRect.width > 0) && (elRect.height > 0)) {

        // Walk up the DOM to find the nearest clickable ancestor wrapping the tile. Check for semantic clickable elements (<a>, <button>, role="button") and
        // elements with explicit click handlers first. Track cursor:pointer elements as a fallback for sites using custom click handlers without semantic markup.
        let ancestor: Nullable<HTMLElement> = htmlEl.parentElement;
        let pointerFallback: Nullable<HTMLElement> = null;

        while(ancestor && (ancestor !== document.body)) {

          const tag = ancestor.tagName;

          // Semantic clickable elements are the most reliable indicators of an interactive tile container.
          if((tag === "A") || (tag === "BUTTON") || (ancestor.getAttribute("role") === "button") || ancestor.hasAttribute("onclick")) {

            ancestor.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

            const rect = ancestor.getBoundingClientRect();

            if((rect.width > 0) && (rect.height > 0)) {

              return { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
            }
          }

          // Track the nearest cursor:pointer ancestor with reasonable dimensions as a fallback.
          if(!pointerFallback) {

            const rect = ancestor.getBoundingClientRect();

            if((rect.width > 20) && (rect.height > 20) && (window.getComputedStyle(ancestor).cursor === "pointer")) {

              pointerFallback = ancestor;
            }
          }

          ancestor = ancestor.parentElement;
        }

        // Fallback: use cursor:pointer ancestor if no semantic clickable was found above.
        if(pointerFallback) {

          pointerFallback.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });

          const rect = pointerFallback.getBoundingClientRect();

          if((rect.width > 0) && (rect.height > 0)) {

            return { x: rect.x + (rect.width / 2), y: rect.y + (rect.height / 2) };
          }
        }
      }
    }

    return null;
  }, [selector]);
}

/**
 * Verifies a tile click on an auto-play site by waiting for a video element in any of the page's frames, clicking the tile again with fresh coordinates when
 * none appears. After the last click the strategy reports success either way, leaving the coordinator's own wait for the video to decide the tune, as it did
 * before clicks were verified.
 * @param page - The Puppeteer page object.
 * @param selector - The resolved matchSelector, re-read before each further click.
 */
async function verifyAutoPlayClick(page: Page, selector: string): Promise<void> {

  for(let attempt = 1; attempt <= MAX_TILE_CLICK_ATTEMPTS; attempt++) {

    // eslint-disable-next-line no-await-in-loop
    if(await waitForAnyVideo(page, TILE_CLICK_VERIFY_TIMEOUT)) {

      return;
    }

    if(attempt === MAX_TILE_CLICK_ATTEMPTS) {

      return;
    }

    // eslint-disable-next-line no-await-in-loop
    const target = await findTileTarget(page, selector);

    if(!target) {

      return;
    }

    LOG.info("Tile click attempt %s of %s did not start a video. Clicking again.", attempt, MAX_TILE_CLICK_ATTEMPTS);

    // eslint-disable-next-line no-await-in-loop
    await scrollAndClick(page, target);
  }
}

/**
 * Polls the page's frames for a video element.
 * @param page - The Puppeteer page object.
 * @param timeoutMs - How long to keep looking, in milliseconds.
 * @returns Whether a video element appeared in any frame within the time.
 */
async function waitForAnyVideo(page: Page, timeoutMs: number): Promise<boolean> {

  const deadline = systemClock.now() + timeoutMs;

  for(;;) {

    for(const frame of page.frames()) {

      try {

        // eslint-disable-next-line no-await-in-loop
        if(await frame.$("video")) {

          return true;
        }
      } catch {

        // A frame detached mid-check holds no video for us.
      }
    }

    if(systemClock.now() >= deadline) {

      return false;
    }

    // eslint-disable-next-line no-await-in-loop
    await systemClock.delay(VIDEO_POLL_INTERVAL);
  }
}

export const tileClickStrategy: ChannelStrategyEntry = { execute: tileClickStrategyFn };

/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * highFrameRate.ts: Runs chosen channels at a higher frame rate, one stream at a time.
 *
 * A list of channel keys is read from HFR_CHANNELS_URL (a JSON document, {"generated": "<ISO time>", "channels": ["nflredzone", ...]}), which something
 * outside PrismCast keeps current - in merzatv, the guide container marks the channels carrying a live NFL game. A stream that starts on a listed channel while
 * fewer than HFR_MAX_STREAMS (default 1) other streams run at the higher rate gets HFR_FRAME_RATE (default 60) and at least HFR_VIDEO_BITRATE (default 12 Mbps);
 * every other stream keeps the configured settings. The default is one because Chrome decodes protected video in software and draws every capture window in
 * one GPU process: with x11grab, one 720p60 stream held 60 distinct frames a second on merzabox and two fell to 30-35 each.
 *
 * Without the variable, or when the list cannot be read or is older than LIST_MAX_AGE, nothing is listed and every stream runs as configured.
 */
import { LOG, timeoutSignal } from "../utils/index.ts";
import type { StreamSettings } from "../config/streamSettings.ts";
import { systemClock } from "homebridge-plugin-utils";

// How often the list is read.
const POLL_INTERVAL_MS = 30000;

// A list whose generated time is older than this is ignored: whatever writes it has stopped.
const LIST_MAX_AGE_MS = 15 * 60 * 1000;

export interface HighFrameRatePolicy {

  readonly channels: ReadonlySet<string>;
  readonly frameRate: number;
  readonly maxStreams: number;
  readonly videoBitsPerSecond: number;
}

/**
 * Reads the list document. Returns the channel keys, or null when the document is not a list or is stale.
 * @param body - The parsed JSON.
 * @param now - The current time in milliseconds.
 * @returns The keys, or null.
 */
export function parseHighFrameRateList(body: unknown, now: number): Set<string> | null {

  if((typeof body !== "object") || (body === null)) {

    return null;
  }

  const { channels, generated } = body as { channels?: unknown; generated?: unknown };

  if(!Array.isArray(channels) || !channels.every((key) => typeof key === "string")) {

    return null;
  }

  const stamp = (typeof generated === "string") ? Date.parse(generated) : NaN;

  if(Number.isNaN(stamp) || ((now - stamp) > LIST_MAX_AGE_MS)) {

    return null;
  }

  return new Set(channels);
}

/**
 * Applies the policy to a new stream's settings: the higher rate when its channel is listed, it would raise the rate, and fewer than maxStreams running streams
 * already run above the configured rate.
 * @param settings - The new stream's settings, from the configuration.
 * @param channelName - The new stream's channel key.
 * @param running - The settings of the streams already running.
 * @param policy - The policy.
 * @returns The settings to use: the same object when nothing changes.
 */
export function applyHighFrameRate(settings: StreamSettings, channelName: string, running: readonly StreamSettings[], policy: HighFrameRatePolicy): StreamSettings {

  if(!policy.channels.has(channelName) || (policy.frameRate <= settings.frameRate)) {

    return settings;
  }

  if(running.filter((other) => other.frameRate > settings.frameRate).length >= policy.maxStreams) {

    return settings;
  }

  return Object.freeze({ ...settings, frameRate: policy.frameRate, videoBitsPerSecond: Math.max(settings.videoBitsPerSecond, policy.videoBitsPerSecond) });
}

let listed: ReadonlySet<string> = new Set();
let polling = false;

/**
 * Reads the list once and keeps it; a failed read clears it, so a dead source cannot hold a channel at the higher rate.
 * @param url - The list's URL.
 */
async function readList(url: string): Promise<void> {

  const bound = timeoutSignal(10000);

  try {

    const response = await fetch(url, { signal: bound.signal });
    const parsed = response.ok ? parseHighFrameRateList(await response.json(), systemClock.now()) : null;
    const next = parsed ?? new Set<string>();

    if([...next].sort().join(",") !== [...listed].sort().join(",")) {

      LOG.info("High frame rate channels: %s.", next.size ? [...next].sort().join(", ") : "none");
    }

    listed = next;
  } catch(error) {

    if(listed.size) {

      LOG.warn("Could not read the high frame rate list, so no channel is listed: %s.", error instanceof Error ? error.message : String(error));
    }

    listed = new Set();
  } finally {

    bound.cancel();
  }
}

/**
 * Returns the current policy, starting the list's polling on the first call when HFR_CHANNELS_URL is set.
 * @returns The policy.
 */
export function getHighFrameRatePolicy(): HighFrameRatePolicy {

  const url = process.env["HFR_CHANNELS_URL"];

  if(url && !polling) {

    polling = true;
    void readList(url);
    systemClock.schedule((): void => void readList(url), POLL_INTERVAL_MS, { repeat: true });
  }

  return {

    channels: listed,
    frameRate: Number(process.env["HFR_FRAME_RATE"] ?? "60") || 60,
    maxStreams: Math.max(0, Math.floor(Number(process.env["HFR_MAX_STREAMS"] ?? "1"))) || 0,
    videoBitsPerSecond: Number(process.env["HFR_VIDEO_BITRATE"] ?? "12000000") || 12000000
  };
}

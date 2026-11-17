/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * highFrameRate.test.ts: Tests for the high frame rate list's parsing and the one-at-a-time rule.
 */
import { applyHighFrameRate, parseHighFrameRateList } from "./highFrameRate.ts";
import { describe, test } from "node:test";
import type { HighFrameRatePolicy } from "./highFrameRate.ts";
import type { StreamSettings } from "../config/streamSettings.ts";
import assert from "node:assert/strict";
import { makeStreamSettings } from "../config/streamSettings.helpers.ts";

const NOW = Date.parse("2026-11-16T19:30:00-06:00");
const BASE: StreamSettings = makeStreamSettings({ frameRate: 30, videoBitsPerSecond: 8000000 });
const POLICY: HighFrameRatePolicy = { channels: new Set([ "espn", "nflredzone" ]), frameRate: 60, maxStreams: 1, videoBitsPerSecond: 12000000 };

describe("parseHighFrameRateList", () => {

  test("answers the listed keys of a fresh list", () => {

    assert.deepEqual(parseHighFrameRateList({ channels: ["espn"], generated: new Date(NOW - 60000).toISOString() }, NOW), new Set(["espn"]));
    assert.deepEqual(parseHighFrameRateList({ channels: [], generated: new Date(NOW).toISOString() }, NOW), new Set());
  });

  test("answers null for a stale list, a missing or bad stamp, or anything that is not a list of keys", () => {

    for(const body of [ { channels: ["espn"], generated: new Date(NOW - (16 * 60000)).toISOString() }, { channels: ["espn"] },
      { channels: ["espn"], generated: "soon" }, { channels: "espn", generated: new Date(NOW).toISOString() },
      { channels: [1], generated: new Date(NOW).toISOString() }, null, "espn", ["espn"] ]) {

      assert.equal(parseHighFrameRateList(body, NOW), null, JSON.stringify(body));
    }
  });
});

describe("applyHighFrameRate", () => {

  test("raises a listed channel's frame rate and bitrate when nothing else runs fast", () => {

    const settings = applyHighFrameRate(BASE, "espn", [BASE], POLICY);

    assert.equal(settings.frameRate, 60);
    assert.equal(settings.videoBitsPerSecond, 12000000);
    assert.equal(settings.segmentDuration, BASE.segmentDuration, "everything else is the configured value");
    assert.ok(Object.isFrozen(settings));
  });

  test("keeps the configured settings for an unlisted channel, or while another stream runs fast", () => {

    assert.equal(applyHighFrameRate(BASE, "cnn", [], POLICY), BASE);
    assert.equal(applyHighFrameRate(BASE, "espn", [{ ...BASE, frameRate: 60 }], POLICY), BASE);
  });

  test("allows up to maxStreams fast streams at once", () => {

    const fast = { ...BASE, frameRate: 60 };
    const two = { ...POLICY, maxStreams: 2 };

    assert.equal(applyHighFrameRate(BASE, "espn", [fast], two).frameRate, 60, "one running fast, room for a second");
    assert.equal(applyHighFrameRate(BASE, "espn", [ fast, BASE, fast ], two), BASE, "two already fast");
    assert.equal(applyHighFrameRate(BASE, "espn", [], { ...POLICY, maxStreams: 0 }), BASE, "zero turns it off");
  });

  test("never lowers a rate or a bitrate", () => {

    const fast = makeStreamSettings({ frameRate: 60, videoBitsPerSecond: 20000000 });

    assert.equal(applyHighFrameRate(fast, "espn", [], POLICY), fast);
    assert.equal(applyHighFrameRate({ ...BASE, videoBitsPerSecond: 20000000 }, "espn", [], POLICY).videoBitsPerSecond, 20000000);
  });
});

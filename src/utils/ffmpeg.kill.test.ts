/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg.kill.test.ts: Tests for the kill escalation in superviseFFmpeg. A killed FFmpeg gets SIGTERM; one that is still running when the grace period ends gets
 * SIGKILL, because an FFmpeg blocked on a pipe can sit on SIGTERM indefinitely and outlive its stream. The rows drive the supervision with a child double that
 * records the signals it is sent, on a virtual clock, so no process is spawned and no real time passes.
 */
import { FFMPEG_KILL_GRACE_MS, superviseFFmpeg } from "./ffmpeg.ts";
import { describe, test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { TestClock } from "homebridge-plugin-utils/testing";
import assert from "node:assert/strict";

/**
 * Builds a child double: an emitter that records each signal it is sent and reports itself killed after the first, as Node's ChildProcess does once a signal is
 * delivered.
 * @returns The double and the signals it received.
 */
function makeChild(): { child: ChildProcess; exit: () => void; signals: string[] } {

  const emitter = new EventEmitter();
  const signals: string[] = [];

  const child = Object.assign(emitter, {

    kill: (signal: string): boolean => {

      signals.push(signal);

      return true;
    },
    get killed(): boolean {

      return signals.length > 0;
    }
  }) as unknown as ChildProcess;

  return { child, exit: (): void => { emitter.emit("exit", null, "SIGTERM"); }, signals };
}

/**
 * Supervises a child double on a virtual clock.
 * @returns The double, the clock, and the supervision.
 */
function supervise(): { clock: TestClock; exit: () => void; kill: () => void; signals: string[] } {

  const clock = new TestClock();
  const { child, exit, signals } = makeChild();
  const supervision = superviseFFmpeg({ clock, ffmpeg: child, label: "FFmpeg", onError: () => { /* No errors expected. */ }, stderr: new PassThrough() });

  return { clock, exit, kill: supervision.kill, signals };
}

describe("superviseFFmpeg kill escalation", () => {

  test("a child still running after the grace period is sent SIGKILL", () => {

    const { clock, kill, signals } = supervise();

    kill();

    assert.deepEqual(signals, ["SIGTERM"], "the kill starts with SIGTERM");

    clock.advance(FFMPEG_KILL_GRACE_MS - 1);

    assert.deepEqual(signals, ["SIGTERM"], "and waits out the grace period");

    clock.advance(1);

    assert.deepEqual(signals, [ "SIGTERM", "SIGKILL" ], "then escalates");
  });

  test("a child that exits within the grace period is not sent SIGKILL", () => {

    const { clock, exit, kill, signals } = supervise();

    kill();
    exit();
    clock.advance(FFMPEG_KILL_GRACE_MS * 2);

    assert.deepEqual(signals, ["SIGTERM"], "the exit cancelled the escalation");
  });

  test("killing a child that has already exited sends nothing", () => {

    const { clock, exit, kill, signals } = supervise();

    exit();
    kill();
    clock.advance(FFMPEG_KILL_GRACE_MS * 2);

    assert.deepEqual(signals, [], "no signal reaches a child that is gone");
  });

  test("repeated kills send SIGTERM once and escalate once", () => {

    const { clock, kill, signals } = supervise();

    kill();
    kill();
    clock.advance(FFMPEG_KILL_GRACE_MS / 2);
    kill();
    clock.advance(FFMPEG_KILL_GRACE_MS * 2);

    assert.deepEqual(signals, [ "SIGTERM", "SIGKILL" ], "one of each, however often teardown asks");
  });
});

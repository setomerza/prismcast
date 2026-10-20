/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * deferredEncoder.ts: The FFmpeg encoder mode's encoder, held back until the stream's video is playing in its capture window.
 *
 * The encoder grabs whatever the capture window shows, and for the length of a tune that is the site's own page: its chrome, a guide, an empty player. Started
 * with the capture, it would put all of that at the head of the stream, ahead of the channel the viewer asked for. So the establishment takes the capture as
 * usual - the capture session has to own it from the moment it exists - but this stands in for the encoder until start(), which the establishment calls once
 * the video is ready, playing, and filling the window:
 *
 * - The capture is piped into the audio sink from its first byte, a deferred pump that follows the recorder's framing and drops the audio until start().
 * - start() reads the clock, spawns the encoder, and starts the pump against that reading, so the audio is anchored to the encoder's own start exactly as it
 *   would be had the encoder been spawned with the capture.
 * - stdout is stable from construction, so the capture session and the error wiring hold one stream for the encoder's whole life; the encoder's output is piped
 *   into it once it exists.
 * - kill() before start() means the encoder is never spawned; after, it kills the encoder, with its SIGTERM-then-SIGKILL escalation, and closes stdout.
 */
import type { EncoderFFmpegProcess, FFmpegProcess } from "../utils/index.ts";
import type { Clock } from "homebridge-plugin-utils";
import type { DeferredRawPump } from "./rawPump.ts";
import type { Nullable } from "../types/index.ts";
import { PassThrough } from "node:stream";
import { createDeferredRawPump } from "./rawPump.ts";
import { systemClock } from "homebridge-plugin-utils";

// Types.

/**
 * The encoder as the capture pipeline holds it: the teardown flag, the kill, and the fMP4 output of an FFmpegProcess, plus the sink the capture is piped into and
 * the start.
 */
export interface DeferredEncoder extends Pick<FFmpegProcess, "isShuttingDown" | "kill" | "stdout"> {

  // The writable the capture stream is piped into: the pump that feeds the encoder's audio pipe once it runs.
  readonly audioSink: DeferredRawPump;

  // Spawns the encoder and starts the pump. Only the first call before a kill() does anything.
  readonly start: () => void;

  // Whether the encoder has been spawned.
  readonly started: boolean;
}

/**
 * What a deferred encoder is built with.
 */
export interface DeferredEncoderOptions {

  // The clock the encoder's start is read on and the pump paces against.
  readonly clock?: Clock;

  // Spawns the encoder FFmpeg. Called at most once.
  readonly spawn: () => EncoderFFmpegProcess;
}

// The deferred encoder.

/**
 * Creates a deferred encoder.
 * @param options - The spawn and the clock.
 * @returns The deferred encoder.
 */
export function createDeferredEncoder(options: DeferredEncoderOptions): DeferredEncoder {

  const { clock = systemClock, spawn } = options;
  const audioSink = createDeferredRawPump({ clock });
  const stdout = new PassThrough();

  let encoder: Nullable<EncoderFFmpegProcess> = null;
  let killed = false;

  const start = (): void => {

    if(encoder || killed) {

      return;
    }

    // The clock is read before the spawn, as the grab's timeline starts no earlier than the spawn: the audio's anchor is the encoder's start.
    const startedAt = clock.now();

    encoder = spawn();
    encoder.stdout.on("error", (error) => { stdout.destroy(error); });
    encoder.stdout.pipe(stdout);
    audioSink.start(encoder.audioIn, startedAt);
  };

  const kill = (): void => {

    killed = true;
    encoder?.kill();
    stdout.destroy();
  };

  return {

    audioSink,
    isShuttingDown: (): boolean => killed || (encoder?.isShuttingDown() ?? false),
    kill,
    start,

    get started(): boolean {

      return encoder !== null;
    },

    stdout
  };
}

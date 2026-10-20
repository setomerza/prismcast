/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * ffmpeg.encoder.test.ts: Tests for the FFmpeg encoder mode's pure pieces: the argv builders, the encoder check, and the search for an FFmpeg that can actually
 * encode. The search runs over a context literal, so no FFmpeg is spawned.
 */
import { buildEncoderFFmpegArgs, buildEncoderProbeArgs, buildVideoEncoderArgs, isFFmpegVideoEncoder, probeEncoderFFmpegPath, x11GrabInput } from "./ffmpeg.ts";
import { describe, test } from "node:test";
import type { EncoderFFmpegOptions } from "./ffmpeg.ts";
import assert from "node:assert/strict";

const OPTIONS: EncoderFFmpegOptions = {

  audioBitrate: 256000,
  encoder: "h264_nvenc",
  frameRate: 30,
  height: 720,
  keyframeInterval: 60,
  platform: "linux",
  videoBitrate: 8000000,
  width: 1280
};

/**
 * Reads the value that follows a flag in an argv.
 * @param args - The argv.
 * @param flag - The flag.
 * @param from - Where to start looking, for flags that repeat per input.
 * @returns The value, or undefined when the flag is absent.
 */
function valueOf(args: string[], flag: string, from = 0): string | undefined {

  const index = args.indexOf(flag, from);

  return (index >= 0) ? args[index + 1] : undefined;
}

describe("buildEncoderFFmpegArgs", () => {

  test("reads raw yuv420p video from stdin and f32le stereo 48 kHz audio from fd 3", () => {

    const args = buildEncoderFFmpegArgs(OPTIONS);
    const videoInput = args.indexOf("pipe:0");
    const audioInput = args.indexOf("pipe:3");

    assert.ok((videoInput > 0) && (audioInput > videoInput), "video is the first input, audio the second");
    assert.equal(valueOf(args, "-f"), "rawvideo");
    assert.equal(valueOf(args, "-pix_fmt"), "yuv420p");
    assert.equal(valueOf(args, "-video_size"), "1280x720");
    assert.equal(valueOf(args, "-framerate"), "30");
    assert.equal(valueOf(args, "-f", videoInput), "f32le", "the audio input's format follows the video input");
    assert.equal(valueOf(args, "-ar"), "48000");
    assert.equal(valueOf(args, "-ac"), "2");
  });

  test("probes neither raw input, so neither pipe waits on the other before encoding starts", () => {

    const args = buildEncoderFFmpegArgs(OPTIONS);
    const videoFormat = args.indexOf("rawvideo");
    const audioFormat = args.indexOf("f32le");

    for(const [ input, formatIndex, from ] of [ [ "video", videoFormat, 0 ], [ "audio", audioFormat, videoFormat ] ] as const) {

      assert.equal(valueOf(args, "-probesize", from), "32", input + " input has a minimal probe");
      assert.equal(valueOf(args, "-analyzeduration", from), "0", input + " input is not analyzed");
      assert.ok(args.indexOf("-probesize", from) < formatIndex, input + " input's probe options precede its format");
      assert.equal(valueOf(args, "-thread_queue_size", from), "1024", input + " input has a deep queue");
    }
  });

  test("encodes with the chosen encoder and AAC, and writes the remux path's fragmented MP4 to stdout", () => {

    const args = buildEncoderFFmpegArgs(OPTIONS);

    assert.equal(valueOf(args, "-c:v"), "h264_nvenc");
    assert.equal(valueOf(args, "-b:v"), "8000000");
    assert.equal(valueOf(args, "-g"), "60", "keyframes at the given interval");
    assert.equal(valueOf(args, "-c:a"), "aac");
    assert.equal(valueOf(args, "-b:a"), "256000");
    assert.equal(valueOf(args, "-movflags"), "frag_keyframe+empty_moov+default_base_moof+skip_sidx+skip_trailer");
    assert.equal(args.at(-1), "pipe:1", "the output comes last");
    assert.ok(!args.includes("-metadata"), "no comment, no metadata flag");
  });

  test("carries a comment and uses AudioToolbox AAC on macOS", () => {

    const args = buildEncoderFFmpegArgs({ ...OPTIONS, comment: "ESPN", platform: "darwin" });

    assert.equal(valueOf(args, "-metadata"), "comment=PrismCast - ESPN");
    assert.equal(valueOf(args, "-c:a"), "aac_at");
    assert.equal(args.at(-1), "pipe:1");
  });
});

describe("buildEncoderFFmpegArgs with a grab region", () => {

  test("grabs the region of the X display at the frame rate without the pointer, and still reads audio from fd 3", () => {

    const args = buildEncoderFFmpegArgs({ ...OPTIONS, grab: { display: ":99", x: 1280, y: 720 } });
    const grabInput = args.indexOf(":99.0+1280,720");

    assert.ok(grabInput > 0, "the region is the first input");
    assert.equal(valueOf(args, "-f"), "x11grab");
    assert.equal(valueOf(args, "-draw_mouse"), "0");
    assert.equal(valueOf(args, "-framerate"), "30");
    assert.equal(valueOf(args, "-video_size"), "1280x720");
    assert.ok(!args.includes("pipe:0"), "nothing is read from stdin");
    assert.ok(!args.includes("rawvideo"), "no raw video input");
    assert.ok(args.indexOf("pipe:3") > grabInput, "the audio is the second input");
    assert.equal(valueOf(args, "-c:v"), "h264_nvenc");
    assert.equal(args.at(-1), "pipe:1");
  });

  test("names the screen for a bare display and keeps one that already has it", () => {

    assert.equal(x11GrabInput({ display: ":99", x: 0, y: 0 }), ":99.0+0,0");
    assert.equal(x11GrabInput({ display: ":1.2", x: 5, y: 7 }), ":1.2+5,7");
  });
});

describe("buildVideoEncoderArgs", () => {

  test("both encoders run constant bitrate with no B-frames and a fixed keyframe interval", () => {

    for(const encoder of [ "h264_nvenc", "libx264" ] as const) {

      const args = buildVideoEncoderArgs(encoder, 5000000, 50);

      assert.equal(args[1], encoder, encoder + " is the codec");
      assert.equal(valueOf(args, "-maxrate"), "5000000", encoder + " caps at the bitrate");
      assert.equal(valueOf(args, "-bufsize"), "10000000", encoder + " buffers two seconds of it");
      assert.equal(valueOf(args, "-bf"), "0", encoder + " has no B-frames");
      assert.equal(valueOf(args, "-g"), "50", encoder + " places keyframes at the interval");
    }

    assert.equal(valueOf(buildVideoEncoderArgs("h264_nvenc", 1, 1), "-rc"), "cbr", "NVENC's rate control is CBR");
    assert.equal(valueOf(buildVideoEncoderArgs("libx264", 1, 30), "-sc_threshold"), "0", "x264 adds no scene-cut keyframes");
  });
});

describe("buildEncoderProbeArgs", () => {

  test("encodes one generated frame to the null muxer", () => {

    const args = buildEncoderProbeArgs("libx264");

    assert.equal(valueOf(args, "-f"), "lavfi");
    assert.equal(valueOf(args, "-frames:v"), "1");
    assert.equal(valueOf(args, "-c:v"), "libx264");
    assert.deepEqual(args.slice(-3), [ "-f", "null", "-" ]);
  });
});

describe("isFFmpegVideoEncoder", () => {

  test("accepts exactly the encoders the mode drives", () => {

    assert.ok(isFFmpegVideoEncoder("h264_nvenc"));
    assert.ok(isFFmpegVideoEncoder("libx264"));
    assert.ok(!isFFmpegVideoEncoder("h264_vaapi"));
    assert.ok(!isFFmpegVideoEncoder(""));
  });
});

describe("probeEncoderFFmpegPath", () => {

  test("answers the first candidate that encodes, trying each distinct candidate once and skipping empty ones", async () => {

    const tried: string[] = [];
    const found = await probeEncoderFFmpegPath("h264_nvenc", {

      candidates: [ undefined, "/bundled/ffmpeg", "", "/bundled/ffmpeg", "ffmpeg", "/last/ffmpeg" ],
      run: async (path: string, args: string[]): Promise<boolean> => {

        tried.push(path);
        assert.equal(valueOf(args, "-c:v"), "h264_nvenc", "each candidate is tested with the encoder itself");

        return path === "ffmpeg";
      }
    });

    assert.equal(found, "ffmpeg");
    assert.deepEqual(tried, [ "/bundled/ffmpeg", "ffmpeg" ], "the duplicate and the empty entries were skipped, and the search stopped at the first success");
  });

  test("answers undefined when no candidate can encode", async () => {

    assert.equal(await probeEncoderFFmpegPath("libx264", { candidates: [ "a", "b" ], run: async (): Promise<boolean> => false }), undefined);
  });
});

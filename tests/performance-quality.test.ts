import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { blank, restoreEdit, srt, parseSrt } from "../src/shared/model";
import {
  writeProjectFiles,
  writeProject,
  readProject,
} from "../src/main/storage";
import { timelineOverview } from "../src/shared/timeline";
import { translationBatches } from "../src/shared/translation";
import { transcriptQuality } from "../src/shared/quality";
import { neighboringFrame } from "../src/main/frame-time";
import { FrameTimes } from "../src/main/frame-time";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { SpeechWorker } from "../src/main/speech-worker";
import { whisperXJob, SpeechJobError } from "../src/main/whisperx";
import type { Settings } from "../src/shared/ipc";
import type { run } from "../src/main/jobs";
import { importWhisperX } from "../src/shared/whisperx";
import { sourceEdit } from "../src/shared/model";
const c = {
  id: "one",
  start: 1,
  end: 4,
  source: "Hello world.",
  target: "你好。",
  status: "draft" as const,
};
test("recognition uncertainty remains separate from confident alignment and is cleared by source correction", () => {
  const [caption] = importWhisperX(
    {
      version: 2,
      language: "en",
      segments: [
        {
          text: "Hello",
          start: 1,
          end: 2,
          recognitionLogprob: -2,
          units: [{ text: "Hello", start: 1, end: 2, confidence: 0.99 }],
        },
      ],
    },
    5,
  );
  assert.equal(caption.recognition?.needsReview, true);
  assert.equal(caption.alignment?.needsReview, false);
  const corrected = sourceEdit(caption, "Corrected");
  assert.equal(corrected.recognition, undefined);
  assert.equal(corrected.alignment?.needsReview, true);
});
test("caption undo preserves immutable speech evidence, including after a new edit", () => {
  const before = { ...blank(), captions: [c] },
    run = {
      id: "raw",
      createdAt: "today",
      mode: "transcription" as const,
      raw: { keep: true },
      captions: [c],
    };
  const after = { ...before, captions: [], speechRuns: [run] };
  const restored = restoreEdit(before, after);
  assert.equal(restored.captions[0], c);
  assert.equal(restored.speechRuns![0], run);
  assert.equal(restoreEdit(after, restored).speechRuns!.length, 1);
});
test("project worker writes identical recovery bytes, coalesces autosaves and recovers after invalid input", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raccoon-worker-"));
  try {
    const a = path.join(dir, "a.captionproj"),
      b = path.join(dir, "b.captionproj"),
      p = { ...blank(), captions: [c] };
    await Promise.all([
      writeProject(a, p),
      ...Array.from({ length: 12 }, (_, i) =>
        writeProjectFiles([a, b], { ...p, name: String(i) }, true),
      ),
    ]);
    assert.equal((await readProject(a)).name, "11");
    assert.equal(await readFile(a, "utf8"), await readFile(b, "utf8"));
    await assert.rejects(
      writeProject(a, { ...p, captions: [{ ...c, end: 0 }] }),
    );
    await writeProject(a, p);
    assert.equal((await readProject(a)).id, p.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("dense timeline overview bounds DOM work and retains the individually selected cue", () => {
  const all = Array.from({ length: 5000 }, (_, i) => ({
    ...c,
    id: String(i),
    start: i * 2,
    end: i * 2 + 1,
  }));
  const overview = timelineOverview(all, "2500", 10000, 1000, 0, 10000);
  assert.ok(overview.individual.length + overview.groups.length < 500);
  assert.ok(overview.individual.some((c) => c.id === "2500"));
  assert.equal(
    overview.individual.length +
      overview.groups.reduce((n, g) => n + g.count, 0),
    all.length,
  );
  const zoomed = timelineOverview(all, "2500", 10000, 256000, 5000, 5010);
  assert.ok(zoomed.individual.length < 10);
  assert.equal(zoomed.groups.length, 0);
  assert.ok(
    timelineOverview(
      all,
      "2500",
      10000,
      1000,
      0,
      10000,
      new Map([["1", "Overlap"]]),
    ).groups.some((group) => group.overlap),
  );
});
test("sparse translation batches keep reviewed text as context without fragmenting requests", () => {
  const captions = Array.from({ length: 200 }, (_, i) => ({
    ...c,
    id: String(i),
    start: i * 2,
    end: i * 2 + 1,
    source: "A sentence.",
    status: i % 2 ? ("reviewed" as const) : ("empty" as const),
  }));
  const batches = translationBatches(
    { ...blank(), captions },
    { mode: "needed", ids: [], checkMeaning: true },
  );
  assert.equal(batches.length, 10);
  assert.equal(batches.flatMap((b) => b.captions).length, 100);
  assert.ok(batches[0].between.some((c) => c.status === "reviewed"));
  assert.ok(
    batches.every((b) => b.captions.every((c) => c.status !== "reviewed")),
  );
});
test("quality metrics distinguish word errors and timing errors, and SRT keeps paragraph text", () => {
  assert.equal(
    parseSrt(
      srt(
        { ...blank(), captions: [{ ...c, source: "First.\n \n \nSecond." }] },
        "source",
      ),
    )[0].source,
    "First.\nSecond.",
  );
  assert.equal(
    translationBatches(
      { ...blank(), captions: [{ ...c, target: "", status: "draft" }] },
      { mode: "needed", ids: [], checkMeaning: true },
    ).length,
    1,
  );
  assert.equal(
    transcriptQuality("Hello world", "hello world.").wordErrorRate,
    0,
  );
  assert.equal(transcriptQuality("Do not go", "Do go").wordErrors, 1);
  const score = transcriptQuality(
    "Hello",
    "Hello",
    [{ text: "Hello", start: 1, end: 2 }],
    [{ text: "Hello", start: 1.1, end: 2.3 }],
  );
  assert.equal(score.matchedTimedWords, 1);
  assert.ok(Math.abs(score.p95BoundaryErrorMs! - 300) < 0.001);
  assert.equal(
    parseSrt(
      srt(
        { ...blank(), captions: [{ ...c, source: "First.\n\nSecond." }] },
        "source",
      ),
    )[0].source,
    "First.\nSecond.",
  );
  assert.equal(neighboringFrame([0, 0.04, 0.1, 0.18], 0.04, 1), 0.1);
  assert.equal(neighboringFrame([0, 0.04, 0.1], 0.1, -1), 0.04);
});
test("frame stepping follows actual presentation times on a real variable-frame-rate file", async () => {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  const ffmpeg = require("ffmpeg-static") as string,
    ffprobe = require("ffprobe-static").path as string;
  const dir = await mkdtemp(path.join(os.tmpdir(), "raccoon-vfr-")),
    file = path.join(dir, "vfr.mp4");
  try {
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x120:rate=30",
        "-t",
        "2",
        "-vf",
        "select=if(lt(t\\,1)\\,not(mod(n\\,3))\\,not(mod(n\\,2)))",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        file,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const frames = JSON.parse(
      execFileSync(
        ffprobe,
        [
          "-v",
          "error",
          "-show_frames",
          "-show_entries",
          "frame=best_effort_timestamp_time",
          "-of",
          "json",
          file,
        ],
        { windowsHide: true, encoding: "utf8" },
      ),
    ).frames.map((frame: { best_effort_timestamp_time: string }) =>
      Number(frame.best_effort_timestamp_time),
    ) as number[];
    const gaps = frames.slice(1).map((t, i) => t - frames[i]);
    assert.ok(Math.max(...gaps) - Math.min(...gaps) > 0.02);
    const index = new FrameTimes();
    assert.ok(
      Math.abs(
        (await index.step(file, frames[5] + 0.000001, 1, ffprobe)) - frames[6],
      ) < 0.00001,
    );
    assert.ok(
      Math.abs(
        (await index.step(file, frames[12] + 0.000001, -1, ffprobe)) -
          frames[11],
      ) < 0.00001,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("successful worker exit followed by cancellation still archives completed results", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raccoon-cancel-end-")),
    controller = new AbortController();
  const runner: typeof run = async (exe, args) => {
    if (exe === "ffmpeg") return "";
    const request = JSON.parse(await readFile(args[2], "utf8"));
    await writeFile(
      request.output,
      JSON.stringify({ raw: { transcription: { keep: true } } }),
    );
    controller.abort();
    return "";
  };
  try {
    await assert.rejects(
      whisperXJob(
        { ...blank(), media: { path: "a.wav", duration: 5, fps: 30 } },
        {
          ffmpeg: "ffmpeg",
          whisperxPython: "python",
          whisperxDevice: "cpu",
        } as Settings,
        dir,
        "worker",
        controller.signal,
        () => {},
        undefined,
        runner,
      ),
      (error) => {
        assert.ok(error instanceof SpeechJobError);
        assert.deepEqual(error.speechRun.raw.transcription, { keep: true });
        assert.equal(error.speechRun.raw.cancelled, true);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("warm speech interpreter is reused, cancelled processes exit, and the next request starts fresh", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raccoon-warm-"));
  const fake = path.join(dir, "worker.cjs"),
    request = path.join(dir, "request.json");
  await writeFile(
    fake,
    `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line),r=JSON.parse(fs.readFileSync(p));console.log('STUDIO:'+JSON.stringify({pid:process.pid}));if(!r.wait)console.log('STUDIO:'+JSON.stringify({type:'workerDone',ok:true}));});`,
  );
  const pool = new SpeechWorker(500, () =>
    spawn(process.execPath, [fake], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
  const ids: number[] = [];
  const binary = (data: Buffer) => {
    for (const l of data.toString().trim().split("\n")) {
      const value = JSON.parse(l.slice(7));
      if (value.pid) ids.push(value.pid);
    }
  };
  try {
    await writeFile(request, JSON.stringify({ cache: dir, offline: true }));
    for (let i = 0; i < 2; i++)
      await pool.run(
        "python",
        ["-u", "whisperx_worker.py", request],
        new AbortController().signal,
        () => {},
        binary,
      );
    assert.equal(ids[0], ids[1]);
    await writeFile(
      request,
      JSON.stringify({ cache: dir, offline: true, wait: true }),
    );
    const controller = new AbortController();
    const pending = pool.run(
      "python",
      ["-u", "whisperx_worker.py", request],
      controller.signal,
      () => {},
      (data) => {
        binary(data);
        controller.abort();
      },
    );
    await assert.rejects(pending, /Cancelled/);
    await writeFile(request, JSON.stringify({ cache: dir, offline: true }));
    await pool.run(
      "python",
      ["-u", "whisperx_worker.py", request],
      new AbortController().signal,
      () => {},
      binary,
    );
    assert.notEqual(ids[0], ids.at(-1));
  } finally {
    await pool.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

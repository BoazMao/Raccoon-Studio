import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpeechResource } from "../src/main/speech-resource";
import { nextSpeechAttempt } from "../src/shared/speech-runtime";
import {
  cleanupRuntime,
  managedRuntime,
  markRuntimeVerified,
  directoryBytes,
  trimTorchBuildLibraries,
} from "../src/main/install-whisperx";
import { whisperXJob, SpeechJobError } from "../src/main/whisperx";
import { blank } from "../src/shared/model";
import type { Settings } from "../src/shared/ipc";
import type { run } from "../src/main/jobs";

test("parallel storage inventory retains every file size and build trimming preserves runtime DLLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raccoon-size-"));
  const site = path.join(root, "Lib/site-packages");
  try {
    await mkdir(path.join(site, "torch/lib"), { recursive: true });
    await mkdir(path.join(site, "torch-2.8.0+cuda.dist-info"));
    await mkdir(path.join(site, "torch-2.8.0+cpu.dist-info"));
    const metadata = "Version: 2.8.0+cpu\n";
    await writeFile(
      path.join(site, "torch-2.8.0+cpu.dist-info/METADATA"),
      metadata,
    );
    await writeFile(path.join(site, "torch/lib/dnnl.lib"), Buffer.alloc(50));
    await writeFile(
      path.join(site, "torch/lib/torch_cpu.dll"),
      Buffer.alloc(100),
    );
    await writeFile(path.join(site, "torch/lib/custom.lib"), Buffer.alloc(150));
    assert.equal(await directoryBytes(root), metadata.length + 300);
    assert.equal(await trimTorchBuildLibraries(root, "cpu"), 50);
    assert.equal(await directoryBytes(root), metadata.length + 250);
    assert.deepEqual((await readdir(path.join(site, "torch/lib"))).sort(), [
      "custom.lib",
      "torch_cpu.dll",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed and cancelled alignment retains complete recognition and finished word/character outputs", async () => {
  for (const cancel of [false, true]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "raccoon-partial-"));
    const controller = new AbortController();
    const p = blank();
    p.media = { path: "C:/speech.wav", duration: 11, fps: 30 };
    const config = {
      ffmpeg: "ffmpeg.exe",
      whisperxPython: "python.exe",
      whisperxModel: "medium",
      whisperxDevice: "cuda",
      whisperxCache: "C:/models",
    } as Settings;
    const recognition = {
      segments: [{ text: "Complete source", start: 1, end: 2 }],
      extra: { keep: true },
    };
    const alignment = {
      input: recognition.segments[0],
      output: { segments: [], characters: [{ char: "C", start: 1 }] },
    };
    const runner: typeof run = async (exe, args) => {
      if (exe === "ffmpeg.exe") return "";
      const request = JSON.parse(await readFile(args[2], "utf8"));
      await writeFile(
        request.checkpoint,
        JSON.stringify({
          transcription: recognition,
          execution: { device: "cuda" },
        }),
      );
      await writeFile(
        path.join(dir, "alignment-checkpoint.jsonl"),
        JSON.stringify(alignment) + '\n{"partial',
      );
      if (cancel) controller.abort();
      throw Error(cancel ? "Cancelled" : "Alignment failed");
    };
    try {
      await assert.rejects(
        whisperXJob(
          p,
          config,
          dir,
          "worker.py",
          controller.signal,
          () => {},
          undefined,
          runner,
        ),
        (error) => {
          assert.ok(error instanceof SpeechJobError);
          assert.deepEqual(error.speechRun.raw.transcription, recognition);
          assert.deepEqual(error.speechRun.raw.alignments, [alignment]);
          assert.equal(error.speechRun.raw.cancelled, cancel);
          assert.deepEqual(error.speechRun.captions, []);
          return true;
        },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("speech resource serializes work, removes cancelled awaiters and releases after errors", async () => {
  const slot = new SpeechResource();
  const a = new AbortController(),
    b = new AbortController(),
    c = new AbortController();
  const release = await slot.acquire(a.signal);
  const cancelled = slot.acquire(b.signal);
  const assertCancelled = assert.rejects(cancelled, /Cancelled/);
  b.abort();
  await assertCancelled;
  let acquired = false;
  const next = slot.use(c.signal, async () => {
    acquired = true;
    throw Error("inference failure");
  });
  const assertFailure = assert.rejects(next, /inference failure/);
  await Promise.resolve();
  assert.equal(acquired, false);
  release();
  release();
  await assertFailure;
  await slot.use(a.signal, async () => assert.equal(acquired, true));
});

test("GPU recovery reduces batches without changing model/precision and respects explicit device choice", () => {
  const oom = {
    type: "failure" as const,
    code: "gpu_memory" as const,
    stage: "recognition" as const,
    message: "out of memory",
  };
  const initial = { device: "cuda" as const, batch: 4, alignmentCpu: false };
  assert.deepEqual(nextSpeechAttempt(oom, "cuda", initial), {
    ...initial,
    batch: 2,
  });
  assert.equal(
    nextSpeechAttempt(oom, "cuda", { ...initial, batch: 1 }),
    undefined,
  );
  assert.deepEqual(nextSpeechAttempt(oom, "auto", { ...initial, batch: 1 }), {
    device: "cpu",
    batch: 1,
    alignmentCpu: true,
  });
  assert.deepEqual(
    nextSpeechAttempt({ ...oom, stage: "alignment" }, "auto", initial),
    { ...initial, alignmentCpu: true },
  );
  assert.equal(
    nextSpeechAttempt({ ...oom, code: "runtime_error" }, "auto", initial),
    undefined,
  );
  assert.equal(
    nextSpeechAttempt(oom, "auto", { ...initial, device: "cpu", batch: 1 }),
    undefined,
  );
});

test("managed cleanup is gated by real verification and never removes the active or external directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "raccoon-runtime-"));
  const id = "066f8a37-7d57-4e76-bf36-a23dd95b9389",
    old = "0cc3b455-20a7-4c4b-ad19-f91903f2e75f";
  const python = path.join(root, "environments", id, "Scripts/python.exe");
  try {
    await mkdir(path.dirname(python), { recursive: true });
    await writeFile(python, "test placeholder");
    await mkdir(path.join(root, "environments", old));
    await mkdir(path.join(root, "environments", "external"));
    await writeFile(
      path.join(root, "current.json"),
      JSON.stringify({
        key: "whisperx-3.8.6-python-3.12.14-cuda-v2",
        profile: "cuda",
        python: `environments/${id}/Scripts/python.exe`,
      }),
    );
    await assert.rejects(cleanupRuntime(root), /Complete a transcription/);
    await markRuntimeVerified(root, "C:/external/python.exe");
    assert.equal((await managedRuntime(root))?.verifiedAt, undefined);
    await markRuntimeVerified(root, python);
    await cleanupRuntime(root);
    assert.deepEqual(
      (await readdir(path.join(root, "environments"))).sort(),
      [id, "external"].sort(),
    );
    assert.ok((await managedRuntime(root))?.verifiedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator prepares audio once and resumes alignment in a fresh worker with immutable settings", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raccoon-retry-"));
  const p = blank();
  p.media = { path: "C:/Speech & recording.wav", duration: 11, fps: 30 };
  const config = {
    ffmpeg: "ffmpeg.exe",
    whisperxPython: "python.exe",
    whisperxModel: "medium",
    whisperxDevice: "auto",
    whisperxCache: "C:/models",
    whisperxOffline: true,
  } as Settings;
  let conversions = 0;
  const attempts: Record<string, any>[] = [];
  const runner: typeof run = async (exe, args, signal, onText, onBinary) => {
    signal.throwIfAborted();
    if (exe === "ffmpeg.exe") {
      conversions++;
      return "";
    }
    const request = JSON.parse(await readFile(args[2], "utf8"));
    attempts.push(request);
    if (attempts.length === 1) {
      onBinary!(Buffer.from('STUDIO:{"type":"execution","batch":2}\n'));
      onBinary!(
        Buffer.from(
          'STUDIO:{"type":"failure","code":"gpu_memory","stage":"alignment","message":"out of memory"}\n',
        ),
      );
      throw Error("worker exited");
    }
    await writeFile(
      request.output,
      JSON.stringify({
        version: 2,
        language: "en",
        segments: [
          {
            text: "Speech",
            start: 1,
            end: 2,
            units: [{ text: "Speech", start: 1, end: 2, confidence: 0.9 }],
          },
        ],
        raw: {
          transcription: { segments: [{ text: "Speech", start: 1, end: 2 }] },
          execution: {
            recognition: { device: "cuda" },
            alignmentDevice: "cpu",
          },
        },
      }),
    );
    return "";
  };
  try {
    const result = await whisperXJob(
      p,
      config,
      dir,
      "worker.py",
      new AbortController().signal,
      () => {},
      undefined,
      runner,
    );
    assert.equal(conversions, 1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].resume, true);
    assert.equal(attempts[1].alignmentCpu, true);
    assert.equal(attempts[1].model, "medium");
    assert.equal(attempts[1].precision, "float16");
    assert.equal(attempts[1].fallbacks[0].stage, "alignment");
    assert.equal(result.captions[0].source, "Speech");
    assert.equal(config.whisperxDevice, "auto");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

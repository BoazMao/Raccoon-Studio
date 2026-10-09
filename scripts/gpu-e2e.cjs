// Real GPU and CPU recognition/alignment through Electron. Requires a managed CUDA test runtime.
// Native dialogs are automated; speech output and device metadata are never injected.
const { _electron: electron } = require("playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const profile = path.join(root, ".tools/test-work/gpu-profile");
const runtimeRoot =
  process.env.TEST_GPU_RUNTIME_ROOT || path.join(profile, "runtime/whisperx");
const cache = path.join(root, ".tools/test-assets/whisperx-models");
const work = path.join(root, ".tools/test-work/gpu");
(async () => {
  await fs.mkdir(work, { recursive: true });
  const model = process.env.TEST_GPU_MODEL || "tiny.en";
  const loops = Number(process.env.TEST_GPU_LOOPS || 1);
  let audio = path.join(root, ".tools/test-assets/jfk.wav");
  if (loops > 1) {
    audio = path.join(work, "long-speech.wav");
    execFileSync(
      require("ffmpeg-static"),
      [
        "-y",
        "-stream_loop",
        String(loops - 1),
        "-i",
        path.join(root, ".tools/test-assets/jfk.wav"),
        "-c:a",
        "pcm_s16le",
        audio,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(runtimeRoot, "current.json"), "utf8"),
  );
  assert.equal(
    manifest.profile,
    "cuda",
    "Run the opt-in CUDA installer prototype first",
  );
  await fs.writeFile(
    path.join(profile, "settings.json"),
    JSON.stringify({
      speechEngine: "whisperx",
      whisperxManaged: true,
      whisperxRuntimeRoot: runtimeRoot,
      whisperxDevice: "auto",
      whisperxModel: model,
      whisperxCache: cache,
      whisperxOffline:
        model === "tiny.en" || process.env.TEST_GPU_OFFLINE === "1",
      ffmpeg: require("ffmpeg-static"),
      ffprobe: require("ffprobe-static").path,
    }),
  );
  const app = await electron.launch({
    ...(process.env.TEST_PACKAGED
      ? {
          executablePath: path.join(
            root,
            "release/win-unpacked/Raccoon Studio.exe",
          ),
        }
      : {}),
    args: [
      ...(process.env.TEST_PACKAGED ? [] : [root]),
      "--user-data-dir=" + profile,
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "ELECTRON_RUN_AS_NODE",
      ),
    ),
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: "Open audio", exact: false })
      .waitFor();
    await page.evaluate(() => {
      window.realSpeech = null;
      window.speechJobs = [];
      window.studio.onEvent((event) => {
        if (event.type === "captions" || event.type === "aligned")
          window.realSpeech = event;
        if (
          event.type === "job" &&
          ["Transcription", "Alignment", "WhisperX setup"].includes(
            event.job.kind,
          )
        )
          window.speechJobs.push(event.job);
      });
    });
    await page.getByRole("button", { name: "Settings", exact: false }).click();
    await page
      .getByRole("button", { name: "Install GPU support", exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".speech-runtime")
          ?.innerText.includes("RTX 3060"),
      null,
      { timeout: 120000 },
    );
    assert.equal(await page.getByLabel("WhisperX device").inputValue(), "auto");
    await page.screenshot({
      path: path.join(work, "gpu-settings.png"),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, audio);
    await page
      .getByRole("button", { name: "Open audio", exact: false })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector("audio")?.readyState >= 2 &&
        !document.querySelector(".wave-label"),
    );
    const results = [];
    for (const device of model === "tiny.en"
      ? ["auto", "cpu"]
      : ["auto", "cpu", "auto"]) {
      await page.evaluate(async (device) => {
        window.realSpeech = null;
        window.speechJobs = [];
        await window.studio.call("configure", {
          ...(await window.studio.call("settings")),
          whisperxDevice: device,
        });
      }, device);
      const started = Date.now();
      await page
        .getByRole("button", { name: "Transcribe", exact: false })
        .click();
      await page.waitForFunction(
        () =>
          window.realSpeech ||
          window.speechJobs.some((job) => job.state === "failed"),
        null,
        { timeout: 900000 },
      );
      const event = await page.evaluate(() => window.realSpeech);
      assert.ok(
        event,
        JSON.stringify(await page.evaluate(() => window.speechJobs)),
      );
      assert.match(
        event.captions.map((c) => c.source).join(" "),
        /Americans|country|ask/i,
      );
      const execution = event.speechRun.raw.execution;
      assert.equal(
        execution.recognition.device,
        device === "auto" ? "cuda" : "cpu",
      );
      assert.equal(
        execution.alignmentDevice,
        device === "auto" ? "cuda" : "cpu",
      );
      assert.ok(event.speechRun.raw.alignments[0].output.word_segments.length);
      assert.ok(event.captions.some((c) => c.alignment.tokens.length));
      await page.waitForFunction(() =>
        window.speechJobs.some((job) => job.state === "done"),
      );
      results.push({
        model,
        loops,
        device,
        seconds: (Date.now() - started) / 1000,
        execution,
        text: event.captions.map((c) => c.source).join(" "),
      });
      console.log(
        "PASS: real recognition and word alignment",
        JSON.stringify(results.at(-1)),
      );
    }
    const originals = await page
      .locator('textarea[aria-label^="Source caption"]')
      .evaluateAll((items) => items.map((item) => item.value));
    await page.evaluate(async () => {
      window.realSpeech = null;
      window.speechJobs = [];
      await window.studio.call("configure", {
        ...(await window.studio.call("settings")),
        whisperxDevice: "auto",
      });
    });
    await page
      .getByRole("button", { name: "Re-align all", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.realSpeech ||
        window.speechJobs.some((job) => job.state === "failed"),
      null,
      { timeout: 120000 },
    );
    const realigned = await page.evaluate(() => window.realSpeech);
    assert.ok(
      realigned,
      JSON.stringify(await page.evaluate(() => window.speechJobs)),
    );
    assert.equal(realigned.type, "aligned");
    assert.equal(realigned.speechRun.raw.execution.alignmentDevice, "cuda");
    assert.deepEqual(
      realigned.captions.map((caption) => caption.source),
      originals,
    );
    assert.ok(
      realigned.speechRun.raw.alignments[0].output.word_segments.length,
    );
    await page.waitForFunction(() =>
      window.speechJobs.some((job) => job.state === "done"),
    );
    console.log(
      "PASS: actual GPU re-alignment preserves corrected source blocks and full word/character outputs",
    );
    if (process.env.TEST_GPU_PRESSURE === "1") {
      const pressure = path.join(work, "pressure.py");
      await fs.writeFile(
        pressure,
        "import torch,time\nfree,total=torch.cuda.mem_get_info()\nhold=torch.empty((max(1,free-256*1024**2),),dtype=torch.uint8,device='cuda')\nprint('READY',flush=True)\ntime.sleep(180)\n",
      );
      const python = path.join(runtimeRoot, manifest.python);
      const child = spawn(python, ["-u", pressure], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let diagnostics = "";
      child.stderr.on("data", (data) => {
        diagnostics += data.toString();
      });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(Error("GPU allocation test timed out: " + diagnostics)),
            60000,
          );
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(
              Error("GPU allocation test exited " + code + ": " + diagnostics),
            );
          });
          child.stdout.on("data", (data) => {
            if (data.toString().includes("READY")) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        await page.evaluate(async () => {
          window.realSpeech = null;
          window.speechJobs = [];
          await window.studio.call("configure", {
            ...(await window.studio.call("settings")),
            whisperxDevice: "auto",
          });
        });
        await page
          .getByRole("button", { name: "Transcribe", exact: false })
          .click();
        await page.waitForFunction(
          () =>
            window.realSpeech ||
            window.speechJobs.some((job) => job.state === "failed"),
          null,
          { timeout: 180000 },
        );
        const event = await page.evaluate(() => window.realSpeech);
        assert.ok(
          event,
          JSON.stringify(await page.evaluate(() => window.speechJobs)),
        );
        const execution = event.speechRun.raw.execution;
        const recovered = execution.fallbacks.some(
          (failure) => failure.code === "gpu_memory",
        );
        if (recovered)
          assert.ok(
            execution.recognition.device === "cpu" ||
              execution.alignmentDevice === "cpu",
          );
        else assert.equal(execution.recognition.device, "cuda");
        assert.equal(event.speechRun.raw.model, model);
        await page.waitForFunction(() =>
          window.speechJobs.some((job) => job.state === "done"),
        );
        console.log(
          recovered
            ? "PASS: actual GPU memory failure recovers on CPU and preserves the model"
            : "PASS: actual GPU memory pressure completes on CUDA without an allocation failure; fallback was not exercised",
          JSON.stringify(event.speechRun.raw.execution.fallbacks),
        );
      } finally {
        if (child.exitCode === null && child.pid)
          execFileSync(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
      }
    }
    const beforeCancel = await page
      .getByLabel("Source caption 1", { exact: true })
      .inputValue();
    await page.evaluate(async () => {
      window.speechJobs = [];
      window.realSpeech = null;
      await window.studio.call("configure", {
        ...(await window.studio.call("settings")),
        whisperxDevice: "auto",
      });
    });
    await page
      .getByRole("button", { name: "Transcribe", exact: false })
      .click();
    await page.waitForFunction(
      () =>
        window.speechJobs.some(
          (job) =>
            job.message.includes("Transcribing on CUDA") ||
            job.message.includes("Loading transcription model"),
        ),
      null,
      { timeout: 120000 },
    );
    await page.evaluate(async () => {
      const id = window.speechJobs.find(
        (job) => job.kind === "Transcription",
      ).id;
      await window.studio.call("cancel", id);
    });
    await page.waitForFunction(
      () => window.speechJobs.some((job) => job.state === "cancelled"),
      null,
      { timeout: 60000 },
    );
    assert.equal(
      await page.getByLabel("Source caption 1", { exact: true }).inputValue(),
      beforeCancel,
    );
    assert.equal(await page.evaluate(() => window.realSpeech), null);
    console.log(
      "PASS: real GPU worker cancellation preserves current captions",
    );
    const file = path.join(work, "gpu.captionproj");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page.getByRole("button", { name: /Save project/ }).click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Project saved"),
    );
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.ok(saved.waveform);
    assert.ok(
      saved.speechRuns.some(
        (run) => run.raw.execution.recognition.device === "cuda",
      ),
    );
    assert.ok(
      saved.speechRuns.some(
        (run) => run.raw.execution.recognition.device === "cpu",
      ),
    );
    const verified = JSON.parse(
      await fs.readFile(path.join(runtimeRoot, "current.json"), "utf8"),
    );
    assert.ok(verified.verifiedAt);
    await fs.writeFile(
      path.join(work, `benchmark-${model}.json`),
      JSON.stringify(results, null, 2),
    );
    await page.screenshot({
      path: path.join(work, "gpu-editor.png"),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: execution provenance, full outputs, waveform and captions saved; CUDA runtime verified",
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

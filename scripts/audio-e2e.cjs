// Actual local audio playback, WhisperX recognition/alignment, IPC and files; native dialogs automated.
const { _electron: electron } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const work = path.join(root, ".tools/test-work/audio");
  await fs.mkdir(work, { recursive: true });
  const profile = await fs.mkdtemp(path.join(work, "profile-"));
  const wav = path.join(root, ".tools/test-assets/jfk.wav");
  const mp3 = path.join(work, "Speech & recording.mp3");
  execFileSync(
    require("ffmpeg-static"),
    ["-y", "-i", wav, "-c:a", "libmp3lame", "-q:a", "2", mp3],
    { windowsHide: true, stdio: "ignore" },
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
      Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE"),
    ),
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("button", { name: "Open audio", exact: false })
      .waitFor();
    await page.evaluate(
      async (config) =>
        window.studio.call("configure", {
          ...(await window.studio.call("settings")),
          ...config,
        }),
      {
        ...(process.env.TEST_PACKAGED
          ? {}
          : {
              ffmpeg: require("ffmpeg-static"),
              ffprobe: require("ffprobe-static").path,
            }),
        speechEngine: "whisperx",
        whisperxPython:
          process.env.TEST_WHISPERX_PYTHON ||
          path.join(root, ".tools/whisperx/Scripts/python.exe"),
        whisperxModel: "tiny.en",
        whisperxDevice: "cpu",
        whisperxCache: path.join(root, ".tools/test-assets/whisperx-models"),
        whisperxOffline: true,
      },
    );
    for (const file of [wav, mp3]) {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [file],
        });
      }, file);
      await page
        .getByRole("button", { name: "Open audio", exact: false })
        .click();
      await page.waitForFunction(
        () => document.querySelector("audio")?.readyState >= 2,
      );
      await page.waitForFunction(() => !document.querySelector(".wave-label"));
      assert.equal(await page.locator("video").count(), 0);
      await page
        .getByRole("heading", { name: "Audio preview", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector("audio").currentTime > 0.2,
      );
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await page.getByLabel("Seek audio").fill("2");
      await page.waitForFunction(
        () => Math.abs(document.querySelector("audio").currentTime - 2) < 0.1,
      );
      await page
        .getByRole("button", { name: "Forward one second", exact: true })
        .click();
      await page.waitForFunction(
        () => Math.abs(document.querySelector("audio").currentTime - 3) < 0.1,
      );
      assert.equal(
        await page.getByLabel("Export format").inputValue(),
        "text-source",
      );
    }
    console.log(
      "PASS: real WAV/MP3 import, audio-only playback, seek, one-second stepping and waveform",
    );
    await page
      .getByRole("button", { name: "Transcribe", exact: false })
      .click();
    await page
      .getByLabel("Source caption 1", { exact: true })
      .waitFor({ timeout: 180000 });
    const recognized = await page
      .getByLabel("Source caption 1", { exact: true })
      .inputValue();
    assert.match(recognized, /Americans|country|ask/i);
    assert.ok((await page.locator(".alignment-state.aligned").count()) > 0);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".task")].some(
        (e) =>
          e.textContent.includes("Transcription") &&
          e.textContent.includes("done"),
      ),
    );
    console.log(
      "PASS: actual cached CPU WhisperX tiny.en transcription and forced alignment:",
      recognized,
    );
    await page
      .getByLabel("Source caption 1", { exact: true })
      .fill("Corrected transcript.");
    await page
      .getByLabel("Translation caption 1", { exact: true })
      .fill("已校正。");
    const projectFile = path.join(work, "audio.captionproj");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, projectFile);
    await page.getByRole("button", { name: /Save project/ }).click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Project saved"),
    );
    const saved = JSON.parse(await fs.readFile(projectFile, "utf8"));
    assert.equal(saved.media.kind, "audio");
    assert.equal(saved.media.path, mp3);
    assert.ok(saved.waveform);
    assert.ok(saved.speechRuns[0].raw);
    for (const [format, track, ext] of [
      ["text-source", "source", "txt"],
      ["text-target", "target", "txt"],
      ["srt", "source", "srt"],
    ]) {
      const outputPath = path.join(work, saved.name + "." + track + "." + ext);
      await fs.rm(outputPath, { force: true });
      await app.evaluate(({ dialog }, work) => {
        dialog.showSaveDialog = async (_window, options) => ({
          canceled: false,
          filePath: work + "/" + options.defaultPath,
        });
      }, work);
      await page.getByLabel("Export format").selectOption(format);
      await page
        .getByRole("button", {
          name: format === "srt" ? "Export SRT ↗" : "Export text ↗",
          exact: true,
        })
        .click();
      await page.waitForFunction(
        (message) => document.body.innerText.includes(message),
        format === "srt" ? "Export finished" : "Timestamped text exported",
      );
      for (let attempts = 0; attempts < 100; attempts++) {
        try {
          await fs.access(outputPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      const exported = await fs.readFile(
        path.join(work, saved.name + "." + track + "." + ext),
        "utf8",
      );
      if (ext === "txt") {
        assert.match(
          exported,
          /\[\d{2}:\d{2}:\d{2}\.\d{3} → \d{2}:\d{2}:\d{2}\.\d{3}\]/,
        );
        assert.ok(
          exported.includes(
            track === "source" ? "Corrected transcript." : "已校正。",
          ),
        );
      } else assert.match(exported, / --> /);
    }
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, projectFile);
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector("audio")?.readyState >= 2,
    );
    assert.equal(
      await page.getByLabel("Source caption 1", { exact: true }).inputValue(),
      "Corrected transcript.",
    );
    assert.equal(
      await page
        .getByLabel("Translation caption 1", { exact: true })
        .inputValue(),
      "已校正。",
    );
    await page.evaluate((p) => window.studio.call("compatible", p), saved);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".task")].some(
        (e) =>
          e.textContent.includes("Playback copy") &&
          e.textContent.includes("done"),
      ),
    );
    await page.waitForFunction(
      () => document.querySelector("audio")?.readyState >= 2,
    );
    await page.screenshot({ path: path.join(work, "audio-verification.png") });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: corrected source/translation timestamped TXT, SRT, audio project save/reopen with waveform/raw speech results, and FFmpeg WAV playback copy",
    );
  } finally {
    await app.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

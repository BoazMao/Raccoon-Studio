const { _electron: electron } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises"),
  http = require("node:http"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  work = path.join(root, ".tools", "test-work"),
  assets = path.join(root, ".tools", "test-assets"),
  dir = path.join(work, "pipeline");
(async () => {
  await fs.mkdir(dir, { recursive: true });
  const ffmpeg = require("ffmpeg-static"),
    fixture = path.join(dir, "speech.mp4");
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1c3940:s=640x360:r=30",
      "-i",
      path.join(assets, "jfk.wav"),
      "-shortest",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      fixture,
    ],
    { stdio: "ignore", windowsHide: true, cwd: dir },
  );
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-i",
      fixture,
      "-map",
      "0",
      "-c",
      "copy",
      "-f",
      "dash",
      path.join(dir, "speech.mpd"),
    ],
    { stdio: "ignore", windowsHide: true, cwd: dir },
  );
  let failNext = false,
    slow = false;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/v1/chat/completions") {
        let data = "";
        for await (const b of req) data += b;
        const parsed = JSON.parse(data);
        assert.ok(parsed.model);
        if (slow) await new Promise((r) => setTimeout(r, 4000));
        if (failNext) {
          failNext = false;
          res.writeHead(401);
          res.end("test failure");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: (() => {
                    const input = JSON.parse(parsed.messages[1].content);
                    const review = !!input.proposedTranslations;
                    return JSON.stringify({
                      [review ? "reviews" : "translations"]:
                        input.captionsToTranslate.map((c) => ({
                          id: c.id,
                          text: "Traducción: " + c.source,
                          ...(review ? { issues: [] } : {}),
                        })),
                    });
                  })(),
                },
              },
            ],
          }),
        );
        return;
      }
      const name = path.basename(new URL(req.url, "http://localhost").pathname),
        data = await fs.readFile(path.join(dir, name));
      res.setHeader(
        "Content-Type",
        name.endsWith(".mpd")
          ? "application/dash+xml"
          : name.endsWith(".m4s")
            ? "video/iso.segment"
            : "video/mp4",
      );
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
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
      "--user-data-dir=" + path.join(dir, "profile-" + Date.now()),
    ],
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "ELECTRON_RUN_AS_NODE"),
    ),
  });
  try {
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Open local video", exact: true })
      .waitFor();
    await page.evaluate(
      async (config) => {
        await window.studio.call("configure", {
          ...(await window.studio.call("settings")),
          ...config,
        });
      },
      {
        ...(process.env.TEST_PACKAGED
          ? {}
          : {
              ffmpeg,
              ffprobe: require("ffprobe-static").path,
              ytdlp: path.join(assets, "yt-dlp.exe"),
              whisper: path.join(assets, "whisper/Release/whisper-cli.exe"),
            }),
        modelPath: path.join(assets, "ggml-tiny.en.bin"),
        speechEngine: process.env.TEST_WHISPERX ? "whisperx" : "whispercpp",
        whisperxPython:
          process.env.TEST_WHISPERX_PYTHON ||
          path.join(root, ".tools/whisperx/Scripts/python.exe"),
        whisperxModel: "tiny.en",
        whisperxDevice: "cpu",
        whisperxCache: path.join(assets, "whisperx-models"),
        whisperxOffline: !!process.env.TEST_WHISPERX_OFFLINE,
        endpoint: base + "/v1",
        model: "test-compatible",
        apiKey: "",
      },
    );
    const downloadDir = path.join(dir, "download-" + Date.now());
    await fs.mkdir(downloadDir, { recursive: true });
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [dir],
      });
    }, downloadDir);
    await page.getByRole("button", { name: "Video URL", exact: false }).click();
    await page
      .getByLabel("Video URL", { exact: true })
      .fill(base + "/speech.mpd");
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page
      .getByRole("button", { name: "Download & import" })
      .waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: "Download & import" }).click();
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
      {},
      { timeout: 60000 },
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".task")].some(
        (e) =>
          e.textContent.includes("Waveform") && e.textContent.includes("done"),
      ),
    );
    assert.equal(
      (await page.locator("video").evaluate((v) => v.duration)) > 5,
      true,
    );
    console.log(
      "PASS: real yt-dlp metadata, DASH audio/video download, FFmpeg merge and automatic import",
    );
    await page
      .getByRole("button", { name: "Transcribe", exact: false })
      .click();
    await page
      .getByLabel("Source caption 1", { exact: true })
      .waitFor({ timeout: 120000 });
    const source = await page
      .getByLabel("Source caption 1", { exact: true })
      .inputValue();
    assert.ok(source.length > 10);
    assert.ok((await page.locator(".alignment-state.aligned").count()) >= 1);
    assert.ok(+(await page.getByLabel("Start 1").inputValue()) > 0.1);
    console.log(
      process.env.TEST_WHISPERX
        ? "PASS: real WhisperX tiny.en transcription with forced alignment:"
        : "PASS: real whisper.cpp tiny.en transcription with automatic DTW alignment:",
      source.slice(0, 100),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".task")].some(
        (e) =>
          e.textContent.includes("Transcription") &&
          e.textContent.includes("done"),
      ),
    );
    failNext = true;
    if (process.env.TEST_WHISPERX) {
      const count = await page.locator(".caption-row").count();
      await page
        .getByRole("button", { name: "Re-align all", exact: true })
        .click();
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll(".task")].some(
            (e) =>
              e.textContent.includes("Alignment") &&
              e.textContent.includes("done"),
          ),
        {},
        { timeout: 120000 },
      );
      assert.equal(await page.locator(".caption-row").count(), count);
      assert.equal(
        await page.getByLabel("Source caption 1", { exact: true }).inputValue(),
        source,
      );
      console.log(
        "PASS: real WhisperX re-alignment preserves caption count and source text",
      );
      const archiveFile = path.join(dir, "speech-archive.captionproj");
      await app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: file,
        });
      }, archiveFile);
      await page.getByRole("button", { name: /Save project/ }).click();
      await page.waitForFunction(() =>
        document.body.innerText.includes("Project saved"),
      );
      const stored = JSON.parse(await fs.readFile(archiveFile, "utf8"));
      assert.equal(stored.speechRuns.length, 2);
      const first = stored.speechRuns[0];
      const sentences = first.raw.alignments
        .flatMap((x) => x.output.segments)
        .filter((x) => x.text.trim());
      assert.deepEqual(
        first.captions.map((c) => c.source),
        sentences.map((s) => s.text),
      );
      assert.ok(first.raw.transcription.segments.length);
      assert.ok(sentences.some((s) => s.chars?.length));
      assert.ok(stored.speechRuns[1].raw.correctedCaptions.length);
      console.log(
        "PASS: exact WhisperX sentence blocks and complete transcription/word/character archives saved to project",
      );
    }
    await page
      .getByRole("button", { name: "Translate →", exact: true })
      .click();
    await page.waitForFunction(() => document.querySelector(".review.failed"));
    await page.waitForFunction(() => !document.querySelector(".task.running"));
    await page
      .getByRole("button", { name: "Translate →", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Translation caption 1"]')
        ?.value.startsWith("Traducción:"),
    );
    await page.waitForFunction(() => !document.querySelector(".task.running"));
    assert.ok(
      (
        await page
          .getByLabel("Translation caption 1", { exact: true })
          .inputValue()
      ).startsWith("Traducción:"),
    );
    await page.locator(".review").first().click();
    await page.locator(".review.reviewed").first().waitFor();
    await page
      .getByLabel("Source caption 1", { exact: true })
      .fill(source + " Edited.");
    await page.locator(".review.stale").first().waitFor();
    console.log(
      "PASS: compatible HTTP translation, failure flag, retry, review and source invalidation (local test endpoint, not an AI quality test)",
    );
    const sourceFile = path.join(dir, "source.srt"),
      targetFile = path.join(dir, "target.srt");
    await app.evaluate(
      ({ dialog }, files) => {
        let i = 0;
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: files[i++],
        });
      },
      [sourceFile, targetFile],
    );
    await page
      .getByRole("button", { name: "Export SRT", exact: false })
      .click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Export finished"),
    );
    assert.match(await fs.readFile(sourceFile, "utf8"), /-->/);
    assert.match(await fs.readFile(targetFile, "utf8"), /Traducción/);
    slow = true;
    await page
      .getByRole("button", { name: "Translate →", exact: true })
      .click();
    await page.locator(".task.running").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".task.cancelled"));
    await page.screenshot({
      path: path.join(root, "workflow-verification.png"),
    });
    console.log("PASS: separate SRT exports and in-flight HTTP cancellation");
  } catch (e) {
    console.error(await (await app.firstWindow()).locator("body").innerText());
    throw e;
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

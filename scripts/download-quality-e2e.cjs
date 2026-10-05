const { _electron: electron } = require("playwright");
const { execFileSync } = require("node:child_process");
const { createServer } = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const work = path.join(root, ".tools/test-work/download-quality");
  await fs.mkdir(work, { recursive: true });
  const download = await fs.mkdtemp(path.join(work, "downloads-"));
  const profile = await fs.mkdtemp(path.join(work, "profile-"));
  execFileSync(
    require("ffmpeg-static"),
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "3",
      "-map",
      "0:v",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-filter:v:0",
      "scale=320:180",
      "-filter:v:1",
      "scale=640:360",
      "-c:v",
      "libx264",
      "-b:v:0",
      "200k",
      "-b:v:1",
      "600k",
      "-c:a",
      "aac",
      "-adaptation_sets",
      "id=0,streams=v id=1,streams=a",
      "-f",
      "dash",
      path.join(work, "video.mpd"),
    ],
    { stdio: "pipe", windowsHide: true, cwd: work },
  );
  const server = createServer(async (req, res) => {
    try {
      const name = path.basename(new URL(req.url, "http://localhost").pathname);
      const body = await fs.readFile(path.join(work, name));
      res.setHeader(
        "Content-Type",
        name.endsWith("mpd") ? "application/dash+xml" : "video/mp4",
      );
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let app;
  try {
    app = await electron.launch({
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
          ([k]) => k !== "ELECTRON_RUN_AS_NODE",
        ),
      ),
    });
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Video URL", exact: false })
      .waitFor();
    if (!process.env.TEST_PACKAGED)
      await page.evaluate(
        async (config) => {
          await window.studio.call("configure", {
            ...(await window.studio.call("settings")),
            ...config,
          });
        },
        {
          ffmpeg: require("ffmpeg-static"),
          ffprobe: require("ffprobe-static").path,
          ytdlp: path.join(root, ".tools/bundled-tools/yt-dlp.exe"),
        },
      );
    await page.evaluate(() => {
      window.downloadedMedia = [];
      window.studio.onEvent((e) => {
        if (e.type === "media") window.downloadedMedia.push(e.media);
      });
    });
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, download);
    await page.getByRole("button", { name: "Video URL", exact: false }).click();
    await page
      .getByLabel("Video URL", { exact: true })
      .fill(`http://127.0.0.1:${server.address().port}/video.mpd`);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page
      .getByLabel("Video quality", { exact: true })
      .waitFor({ timeout: 60000 });
    assert.deepEqual(
      await page
        .getByLabel("Video quality", { exact: true })
        .locator("option")
        .allTextContents(),
      ["Best available", "360p or lower", "180p or lower"],
    );
    await page.getByLabel("Video quality", { exact: true }).selectOption("180");
    await page.screenshot({
      path: path.join(root, "download-quality-verification.png"),
    });
    for (const [index, height] of [180, 360].entries()) {
      if (index) {
        await page
          .getByRole("button", { name: "Video URL", exact: false })
          .click();
        await page
          .getByLabel("Video quality", { exact: true })
          .selectOption(String(height));
      }
      await page
        .getByRole("button", { name: "Download & import", exact: true })
        .click();
      await page.waitForFunction(
        (n) => window.downloadedMedia.length === n,
        index + 1,
        { timeout: 60000 },
      );
      await page.waitForFunction(
        (h) => document.querySelector("video")?.videoHeight === h,
        height,
      );
      const media = await page.evaluate(() => window.downloadedMedia.at(-1));
      const probe = JSON.parse(
        execFileSync(
          require("ffprobe-static").path,
          ["-v", "error", "-show_streams", "-of", "json", media.path],
          { encoding: "utf8", windowsHide: true },
        ),
      );
      assert.equal(
        probe.streams.find((s) => s.codec_type === "video").height,
        height,
      );
      assert.ok(probe.streams.some((s) => s.codec_type === "audio"));
      await page.waitForFunction(
        () => !document.querySelector(".task.running"),
      );
    }
    const files = await page.evaluate(() =>
      window.downloadedMedia.map((m) => m.path),
    );
    assert.notEqual(files[0], files[1]);
    console.log(
      "PASS: actual yt-dlp DASH metadata exposes 180p/360p; both selected qualities download, merge with audio, import and play at the requested resolution without filename collisions",
    );
  } finally {
    if (app) await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

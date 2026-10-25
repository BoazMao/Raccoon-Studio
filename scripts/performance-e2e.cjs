// Review probes: real Electron UI/IPC/filesystem, controlled speech-result event.
// This does not run ASR or assess recognition accuracy.
const { _electron: electron } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const root = path.resolve(__dirname, "..");
const work = path.join(root, ".tools/test-work/performance");
(async () => {
  await fs.mkdir(work, { recursive: true });
  const wav = path.join(work, "fixture.wav");
  execFileSync(
    require("ffmpeg-static"),
    ["-y", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "6", wav],
    { windowsHide: true, stdio: "ignore" },
  );
  const profile = await fs.mkdtemp(path.join(work, "profile-"));
  const id = randomUUID();
  const caption = {
    id: "review-c1",
    start: 1,
    end: 4,
    source: "Alpha beta gamma.",
    target: "",
    status: "empty",
  };
  const project = {
    version: 1,
    id,
    name: "Review fixture",
    language: "en",
    targetLanguage: "Chinese",
    media: { path: wav, kind: "audio", duration: 6, fps: 30 },
    captions: [caption],
  };
  const source = path.join(work, "review-base.captionproj");
  const saved = path.join(work, "review-after-undo.captionproj");
  await fs.writeFile(source, JSON.stringify(project));
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
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .waitFor();
    await app.evaluate(
      ({ dialog }, files) => {
        global.reviewSaveCalls = 0;
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [files.source],
        });
        dialog.showSaveDialog = async () => {
          global.reviewSaveCalls++;
          return { canceled: false, filePath: files.saved };
        };
      },
      { source, saved },
    );
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await page.getByLabel("Source caption 1", { exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector("audio")?.readyState >= 2 &&
        !document.querySelector(".wave-label"),
    );
    const recognized = { ...caption, source: "Recognized words." };
    const speechRun = {
      id: "review-raw-run",
      mode: "transcription",
      createdAt: new Date().toISOString(),
      captions: [recognized],
      raw: {
        transcription: { keep: "original raw output", segments: [] },
        alignments: [],
      },
    };
    await app.evaluate(
      ({ BrowserWindow }, event) =>
        BrowserWindow.getAllWindows()[0].webContents.send(
          "studio:event",
          event,
        ),
      {
        type: "captions",
        projectId: id,
        language: "en",
        mode: "replace",
        originals: [caption],
        captions: [recognized],
        speechRun,
      },
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Source caption 1"]').value ===
        "Recognized words.",
    );
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page
      .getByLabel("Source caption 1", { exact: true })
      .fill("Edited after undo.");
    // Save to the fixture's existing path: no dialog is needed.
    await page.getByRole("button", { name: /Save project/ }).click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Project saved"),
    );
    const after = JSON.parse(await fs.readFile(source, "utf8"));
    const archiveLost = !(after.speechRuns || []).some(
      (run) => run.id === speechRun.id,
    );
    console.log(
      "UNDO_ARCHIVE",
      JSON.stringify({ source: after.captions[0].source, archiveLost }),
    );
    assert.equal(archiveLost, false, "Undo must preserve raw results");
    await page.locator(".timeline").focus();
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+Shift+z");
    assert.equal(
      await page.getByLabel("Source caption 1", { exact: true }).inputValue(),
      "Edited after undo.",
    );
    await page.evaluate(() => {
      const a = document.querySelector("audio");
      a.currentTime = 2;
      a.dispatchEvent(new Event("timeupdate"));
    });
    await page.keyboard.press("Control+Shift+S");
    await page.waitForTimeout(500);
    const saveAsCalls = await app.evaluate(() => global.reviewSaveCalls);
    const captionsAfterShortcut = await page.locator(".caption-row").count();
    console.log(
      "SAVE_AS_SHORTCUT",
      JSON.stringify({ saveAsCalls, captionsAfterShortcut }),
    );
    assert.equal(saveAsCalls, 1);
    assert.equal(
      captionsAfterShortcut,
      1,
      "Save As must not split the caption",
    );
    const scale = {
      ...project,
      id: randomUUID(),
      name: "Scale test",
      media: null,
      captions: Array.from({ length: 3000 }, (_, i) => ({
        ...caption,
        id: "scale-" + i,
        start: i * 2,
        end: i * 2 + 1,
        source: "Synthetic sentence " + i,
      })),
    };
    const scaleFile = path.join(work, "scale.captionproj");
    await fs.writeFile(scaleFile, JSON.stringify(scale));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, scaleFile);
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Source caption 1"]')?.value ===
        "Synthetic sentence 0",
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.getByLabel("Source caption 1", { exact: true }).waitFor();
    assert.ok(
      (await page.locator(".caption-row").count()) < 50,
      "Caption rows must be virtualized",
    );
    await page.locator(".caption-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.getByLabel("Source caption 3000", { exact: true }).waitFor();
    await page.getByLabel("Source caption 3000", { exact: true }).click();
    await page
      .getByLabel("Source caption 3000", { exact: true })
      .fill("Last caption edit");
    await page.locator(".timeline").focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    const clipboard = JSON.parse(
      await page.evaluate(() => window.studio.call("clipboardRead")),
    );
    assert.equal(clipboard.captions.length, 3000);
    const rowCount = await page.locator(".caption-row").count();
    assert.ok(rowCount < 50);
    await page.screenshot({
      path: path.join(work, "workspace.png"),
      fullPage: true,
    });
    await fs.writeFile(
      path.join(work, "ui-results.json"),
      JSON.stringify(
        { archiveLost, saveAsCalls, captionsAfterShortcut, rowCount },
        null,
        2,
      ),
    );
    console.log(
      "PASS: raw archives survive undo, Save As preserves captions, virtual rows navigate and select/copy all 3,000 captions",
    );
  } finally {
    await app.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

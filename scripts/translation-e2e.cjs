// Real Electron/IPC/HTTP/persistence; controlled local AI responses, no live-provider quality claim.
const { _electron: electron } = require("playwright");
const { createServer } = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
(async () => {
  const work = path.join(root, ".tools", "test-work", "translation");
  await fs.mkdir(work, { recursive: true });
  const profile = await fs.mkdtemp(path.join(work, "profile-"));
  const file = path.join(work, "translation.captionproj");
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      input = JSON.parse(body.messages[1].content);
    requests.push(body);
    let output;
    if (input.proposedTranslations) {
      output = {
        reviews: input.captionsToTranslate.map((c) => ({
          id: c.id,
          text: c.id === "one" ? "WhisperX 对齐语音。" : "它不会更改模型。",
          issues:
            c.id === "two" ? ["Confirm the intended model reference."] : [],
        })),
      };
    } else {
      assert.equal(input.approvedGuidance.terms[0].target, "WhisperX");
      assert.match(input.approvedGuidance.description, /tutorial/);
      output = {
        translations: input.captionsToTranslate.map((c) => ({
          id: c.id,
          text: "初步译文",
        })),
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let app;
  try {
    const p = {
      version: 1,
      id: crypto.randomUUID(),
      name: "Translation pipeline test",
      media: null,
      language: "en",
      targetLanguage: "Chinese",
      captions: ["one", "two", "three", "four"].map((id, i) => ({
        id,
        start: i * 3,
        end: i * 3 + 3,
        source: [
          "WhisperX aligns speech.",
          "It does not change the model.",
          "Keep my manual draft.",
          "Keep this reviewed caption.",
        ][i],
        target: "",
        status: "empty",
      })),
    };
    await fs.writeFile(file, JSON.stringify(p));
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .waitFor();
    await page.evaluate(async (endpoint) => {
      const settings = await window.studio.call("settings");
      await window.studio.call("configure", {
        ...settings,
        endpoint,
        model: "controlled-test-model",
        apiKey: "",
      });
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await page.getByLabel("Source caption 1", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Analyze context", exact: true })
        .count(),
      0,
    );
    await page
      .getByLabel("Video description", { exact: true })
      .fill("A tutorial explaining WhisperX speech alignment.");
    await page
      .getByLabel("Tone and style", { exact: true })
      .fill("Clear and technical");
    await page.getByRole("button", { name: "Add term", exact: true }).click();
    await page.getByLabel("Glossary source 1").fill("WhisperX");
    await page.getByLabel("Glossary target 1").fill("WhisperX");
    await page.getByLabel("Glossary note 1").fill("Preserve the product name.");
    assert.equal(requests.length, 0);
    await page
      .getByRole("button", { name: "Save guidance", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save guidance", exact: true })
      .waitFor({ state: "visible" });
    assert.equal(
      await page.getByLabel("Glossary target 1").inputValue(),
      "WhisperX",
    );
    await page
      .getByRole("button", { name: "Save to global", exact: true })
      .click();
    await page.getByText(/Saved to global glossary/).waitFor();
    const glossaryFile = path.join(work, "exported-glossary.json");
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, glossaryFile);
    await page
      .getByRole("button", { name: "Save to file", exact: true })
      .click();
    await page.getByText(/Glossary saved to/).waitFor();
    const glossary = JSON.parse(await fs.readFile(glossaryFile, "utf8"));
    assert.equal(glossary.format, "raccoon-studio-glossary");
    assert.equal("captionIds" in glossary.terms[0], false);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, glossaryFile);
    await page.getByLabel("Glossary target 1").fill("Keep local edit");
    await page
      .getByRole("button", { name: "Import file", exact: true })
      .click();
    await page.getByText(/1 existing terms kept/).waitFor();
    assert.equal(
      await page.getByLabel("Glossary target 1").inputValue(),
      "Keep local edit",
    );
    await page
      .getByLabel("Glossary duplicate handling")
      .selectOption("replace");
    await page
      .getByRole("button", { name: "Import file", exact: true })
      .click();
    await page.getByText(/1 replaced/).waitFor();
    assert.equal(
      await page.getByLabel("Glossary target 1").inputValue(),
      "WhisperX",
    );
    await page
      .getByRole("button", { name: "Remove term 1", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Save guidance", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Load global", exact: true })
      .click();
    await page.getByText(/1 added/).waitFor();
    assert.equal(
      await page.getByLabel("Glossary target 1").inputValue(),
      "WhisperX",
    );
    await page
      .getByRole("button", { name: "Save guidance", exact: true })
      .click();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, file);
    await page.screenshot({
      path: path.join(root, "translation-context-verification.png"),
    });
    const geometry = await page.locator(".context-panel").evaluate((el) => ({
      width: el.clientWidth,
      scroll: el.scrollWidth,
      bottom: el.getBoundingClientRect().bottom,
      height: innerHeight,
    }));
    assert.ok(geometry.scroll <= geometry.width + 1);
    assert.ok(geometry.bottom < geometry.height);
    await page
      .getByRole("button", { name: "Close translation context" })
      .click();
    await page
      .getByLabel("Translation caption 3", { exact: true })
      .fill("人工初稿");
    await page
      .getByLabel("Translation caption 4", { exact: true })
      .fill("已经审阅");
    await page.locator(".caption-row").nth(3).locator("button.review").click();
    await page
      .getByRole("button", { name: "Translate →", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Translation caption 1"]').value ===
        "WhisperX 对齐语音。",
    );
    assert.equal(
      await page
        .getByLabel("Translation caption 2", { exact: true })
        .inputValue(),
      "它不会更改模型。",
    );
    assert.equal(
      await page
        .getByLabel("Translation caption 3", { exact: true })
        .inputValue(),
      "人工初稿",
    );
    assert.equal(
      await page
        .getByLabel("Translation caption 4", { exact: true })
        .inputValue(),
      "已经审阅",
    );
    await page
      .getByText("Check meaning: Confirm the intended model reference.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      requests.filter(
        (r) => JSON.parse(r.messages[1].content).captionsToTranslate,
      ).length,
      2,
    );
    await page.getByRole("button", { name: /Save project/ }).click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Project saved"),
    );
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(saved.translationContext.approved.terms[0].target, "WhisperX");
    assert.equal(saved.translationContext.analysis, undefined);
    assert.equal(saved.captions[1].translation.issues[0].kind, "meaning");
    assert.equal(saved.captions[3].status, "reviewed");
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Glossary target 1").inputValue(),
      "WhisperX",
    );
    await page
      .getByRole("button", { name: "Close translation context" })
      .click();
    await page
      .getByLabel("Source caption 1", { exact: true })
      .fill("WhisperX changed.");
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    assert.deepEqual(errors, []);
    await page
      .getByRole("button", { name: "Close translation context" })
      .click();
    const otherFile = path.join(work, "another-project.captionproj");
    await fs.writeFile(
      otherFile,
      JSON.stringify({
        ...p,
        id: crypto.randomUUID(),
        name: "Another project",
      }),
    );
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, otherFile);
    await page
      .getByRole("button", { name: "Open project", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Load global", exact: true })
      .click();
    await page.getByText(/1 added/).waitFor();
    assert.equal(
      await page.getByLabel("Glossary target 1").inputValue(),
      "WhisperX",
    );
    console.log(
      "PASS: glossary file export/import, explicit duplicate policy, global persistence and reuse in another project (actual IPC/filesystem, automated dialogs)",
    );
    // Unsaved glossary terms must reset even when the approved guidance key is unchanged.
    await page
      .getByRole("button", { name: "Close translation context" })
      .click();
    await page.getByLabel("Source language").selectOption("zh");
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Glossary source 1", { exact: true }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Close translation context" })
      .click();
    await page.getByLabel("Source language").selectOption("en");
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Load global", exact: true })
      .click();
    await page.getByText(/1 added/).waitFor();
    await page
      .getByLabel("Video description", { exact: true })
      .fill("Keep general description");
    await page
      .getByRole("button", { name: "Save guidance", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Close translation context" })
      .click();
    await page.getByLabel("Target language").selectOption("English");
    await page
      .getByRole("button", { name: "Translation context", exact: true })
      .click();
    assert.equal(
      await page.getByLabel("Glossary source 1", { exact: true }).count(),
      0,
    );
    assert.equal(
      await page.getByLabel("Video description", { exact: true }).inputValue(),
      "Keep general description",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Save to global", exact: true })
        .isDisabled(),
      true,
    );
    console.log(
      "PASS: language selectors clear approved and unsaved pair-specific glossary terms while preserving general guidance",
    );
    console.log(
      "PASS: actual Electron manual guidance, no analysis requests, batched draft/meaning requests, manual/reviewed protection, review flags and save/reopen (controlled local provider)",
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { videoPreview, downloadFormat } from "../src/shared/download";
import {
  portableGlossary,
  sameGlossaryScope,
  mergeGlossaryTerms,
  GlossaryFileSchema,
} from "../src/shared/glossary";
import {
  readGlossary,
  writeGlossary,
  loadGlobalGlossary,
  saveGlobalGlossary,
} from "../src/main/glossary";

const scope = {
  sourceLanguage: "en" as const,
  targetLanguage: "Chinese" as const,
  chineseVariant: "Simplified" as const,
};
const term = (source: string, target: string) => ({
  source,
  target,
  note: "Usage note",
  captionIds: ["project-only-id"],
});
test("quality preview excludes audio/storyboards/DRM and numeric selectors never fall back above the cap", () => {
  const info = videoPreview({
    title: "Test",
    formats: [
      { vcodec: "none", height: 500 },
      { vcodec: "avc1", height: 720 },
      { vcodec: "vp9", height: 720 },
      { vcodec: "avc1", height: 1080 },
      { vcodec: "avc1", height: 2160, has_drm: true },
      { height: 144, format_note: "storyboard" },
    ],
  });
  assert.deepEqual(info.qualities, [1080, 720]);
  assert.equal(
    downloadFormat(720),
    "bv*[height<=720]+ba/b[height<=720]/bv[height<=720]",
  );
  assert.equal(downloadFormat(), "bv*+ba/b/bv");
  assert.throws(() => downloadFormat("720; something"));
  assert.throws(() => downloadFormat(-1));
  assert.deepEqual(videoPreview({ title: "Unknown resolution" }).qualities, []);
});
test("portable glossary strips project references and validates duplicate terms and language scope", () => {
  const file = portableGlossary(scope, [term("WhisperX", "WhisperX")]);
  assert.equal("captionIds" in file.terms[0], false);
  assert.throws(() =>
    portableGlossary(scope, [term("name", "一"), term("NAME", "二")]),
  );
  assert.equal(
    sameGlossaryScope(scope, { ...scope, chineseVariant: "Traditional" }),
    false,
  );
  assert.equal(
    sameGlossaryScope(scope, { ...scope, sourceLanguage: "zh" }),
    false,
  );
  assert.throws(() => GlossaryFileSchema.parse({ terms: [] }));
});
test("import merging has explicit conflict policy and preserves local evidence", () => {
  const current = [term("WhisperX", "Local choice")];
  const incoming = portableGlossary(scope, [
    term("whisperx", "Imported choice"),
    term("model", "模型"),
  ]).terms;
  const kept = mergeGlossaryTerms(current, incoming, false);
  assert.equal(kept.terms[0].target, "Local choice");
  assert.equal(kept.kept, 1);
  assert.equal(kept.added, 1);
  const replaced = mergeGlossaryTerms(current, incoming, true);
  assert.equal(replaced.terms[0].target, "Imported choice");
  assert.deepEqual(replaced.terms[0].captionIds, ["project-only-id"]);
  assert.deepEqual(replaced.terms[1].captionIds, []);
  assert.equal(current[0].target, "Local choice");
});
test("glossary files roundtrip and concurrent global saves preserve language-scoped entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raccoon-glossary-"));
  try {
    const global = path.join(dir, "global.json"),
      file = path.join(dir, "export.json");
    assert.equal(await loadGlobalGlossary(global, scope), null);
    const first = portableGlossary(scope, [term("WhisperX", "WhisperX")]);
    await writeGlossary(file, first);
    assert.deepEqual(await readGlossary(file), first);
    await Promise.all([
      saveGlobalGlossary(global, first),
      saveGlobalGlossary(
        global,
        portableGlossary(scope, [term("model", "模型")]),
      ),
      saveGlobalGlossary(
        global,
        portableGlossary({ ...scope, chineseVariant: "Traditional" }, [
          term("model", "模型繁體"),
        ]),
      ),
    ]);
    assert.equal((await loadGlobalGlossary(global, scope))?.terms.length, 2);
    assert.equal(
      (
        await loadGlobalGlossary(global, {
          ...scope,
          chineseVariant: "Traditional",
        })
      )?.terms[0].target,
      "模型繁體",
    );
    await saveGlobalGlossary(
      global,
      portableGlossary(scope, [term("MODEL", "新模型")]),
    );
    assert.equal(
      (await loadGlobalGlossary(global, scope))?.terms.find(
        (t) => t.source === "MODEL",
      )?.target,
      "新模型",
    );
    await writeFile(global, "broken existing file");
    await assert.rejects(saveGlobalGlossary(global, first));
    assert.equal(await readFile(global, "utf8"), "broken existing file");
    await writeFile(file, "not JSON");
    await assert.rejects(readGlossary(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

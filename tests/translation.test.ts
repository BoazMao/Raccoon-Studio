import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  blank,
  split,
  merge,
  type Caption,
  type Project,
} from "../src/shared/model";
import {
  approveGuidance,
  emptyGuidance,
  guidanceKey,
  changeLanguages,
} from "../src/shared/context";
import {
  translationBatches,
  validateTranslations,
  applyTranslationBatch,
  readabilityIssues,
  type TranslationBatchEvent,
} from "../src/shared/translation";
import { translateProject } from "../src/main/translation";
import { readProject, writeProject } from "../src/main/storage";
import type { Settings, Event } from "../src/shared/ipc";

const caption = (id: string, source = "WhisperX aligns speech."): Caption => ({
  id,
  source,
  target: "",
  start: Number(id) || 0,
  end: (Number(id) || 0) + 3,
  status: "empty",
});
const project = (): Project => ({
  ...blank(),
  captions: [caption("1"), caption("2", "It does not change the model.")],
});
const options = { mode: "needed" as const, ids: [], checkMeaning: true };
async function provider<T>(
  handler: (
    body: any,
    count: number,
  ) => { status?: number; body?: unknown; wait?: boolean },
  use: (settings: Settings, requests: any[]) => Promise<T>,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    requests.push(body);
    const result = handler(body, requests.length);
    if (result.wait) return;
    res.writeHead(result.status || 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        result.body || { choices: [{ message: { content: "{}" } }] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    return await use(
      {
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: "controlled-test-model",
        apiKey: "",
      } as Settings,
      requests,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const response = (value: unknown) => ({
  body: { choices: [{ message: { content: JSON.stringify(value) } }] },
});

test("fatal meaning errors preserve completed drafts and stop before the next batch", async () => {
  for (const status of [400, 401]) {
    const p = {
      ...project(),
      captions: Array.from({ length: 12 }, (_, i) =>
        caption(String(i), "A sentence."),
      ),
    };
    await provider(
      (body) => {
        const input = JSON.parse(body.messages[1].content);
        return input.proposedTranslations
          ? { status }
          : response({
              translations: input.captionsToTranslate.map((c: Caption) => ({
                id: c.id,
                text: "Initial draft",
              })),
            });
      },
      async (settings, requests) => {
        const events: Event[] = [];
        await assert.rejects(
          translateProject(
            p,
            "request",
            options,
            settings,
            new AbortController().signal,
            () => {},
            (e) => events.push(e),
          ),
          new RegExp(String(status)),
        );
        assert.equal(requests.length, 2);
        assert.equal(events.length, 1);
        const result = applyTranslationBatch(
          p,
          events[0] as TranslationBatchEvent,
        );
        assert.equal(result.applied, 10);
        for (const c of result.project.captions.slice(0, 10)) {
          assert.equal(c.target, "Initial draft");
          assert.equal(c.status, "draft");
          assert.equal(c.error, undefined);
          assert.match(
            c.translation!.issues[0].message,
            /Meaning check failed/,
          );
        }
        assert.ok(
          result.project.captions.slice(10).every((c) => c.status === "empty"),
        );
      },
    );
  }
});

test("language changes clear pair-specific terms while preserving general guidance", () => {
  const p = approveGuidance(project(), {
    ...emptyGuidance(),
    description: "Tutorial",
    tone: "Technical",
    terms: [{ source: "model", target: "模型", note: "", captionIds: [] }],
  });
  p.captions[0] = { ...p.captions[0], target: "译文", status: "reviewed" };
  assert.equal(changeLanguages(p, p.language, p.targetLanguage), p);
  for (const changed of [
    changeLanguages(p, "zh", p.targetLanguage),
    changeLanguages(p, p.language, "English"),
  ]) {
    assert.deepEqual(changed.translationContext!.approved.terms, []);
    assert.equal(changed.translationContext!.approved.description, "Tutorial");
    assert.equal(changed.translationContext!.approved.tone, "Technical");
    assert.equal(changed.captions[0].status, "stale");
    assert.equal(changed.captions[1].status, "empty");
    assert.equal(p.translationContext!.approved.terms.length, 1);
  }
});

test("splits and merges discard obsolete translation findings without mutating the original", () => {
  const c: Caption = {
    ...caption("0", "Hello world"),
    target: "你好世界",
    status: "draft",
    error: "Old failure",
    translation: {
      origin: "ai",
      issues: [{ kind: "meaning", message: "Old concern" }],
    },
  };
  const aligned: Caption = {
    ...c,
    alignment: {
      method: "whisperx",
      needsReview: false,
      tokens: [
        { text: "Hello", start: 0, end: 1, confidence: 1 },
        { text: " world", start: 2, end: 3, confidence: 1 },
      ],
    },
  };
  for (const original of [c, aligned]) {
    for (const part of split(original, 1.5, "new")) {
      assert.equal(part.target, "");
      assert.equal(part.translation, undefined);
      assert.equal(part.error, undefined);
    }
  }
  const combined = merge(c, { ...c, id: "next", start: 3, end: 6 });
  assert.equal(combined.translation, undefined);
  assert.equal(combined.error, undefined);
  assert.equal(combined.status, "stale");
  assert.equal(c.translation!.issues.length, 1);
});

test("translation batches preserve drafts/reviewed rows and include neighboring context", () => {
  const p = project();
  p.captions.push(
    { ...caption("3"), target: "Manual draft", status: "draft" },
    { ...caption("4"), target: "Approved", status: "reviewed" },
  );
  const batches = translationBatches(p, options);
  assert.deepEqual(
    batches[0].captions.map((c) => c.id),
    ["1", "2"],
  );
  assert.deepEqual(
    batches[0].after.map((c) => c.id),
    ["3", "4"],
  );
  assert.deepEqual(
    translationBatches(p, {
      ...options,
      mode: "selected",
      ids: ["3", "4"],
    })[0].captions.map((c) => c.id),
    ["3"],
  );
  const long = {
    ...p,
    captions: Array.from({ length: 45 }, (_, i) =>
      caption(String(i), "A sentence."),
    ),
  };
  assert.equal(
    translationBatches(long, options).flatMap((b) => b.captions).length,
    45,
  );
  assert.ok(
    translationBatches(long, options).every((b) => b.captions.length <= 20),
  );
});
test("response validation rejects missing, duplicate, invented IDs and blank translations", () => {
  for (const translations of [
    [{ id: "1", text: "one" }],
    [
      { id: "1", text: "one" },
      { id: "1", text: "two" },
    ],
    [
      { id: "1", text: "one" },
      { id: "9", text: "two" },
    ],
    [
      { id: "1", text: "one" },
      { id: "2", text: " " },
    ],
  ])
    assert.throws(() => validateTranslations({ translations }, ["1", "2"]));
  assert.deepEqual(
    validateTranslations(
      {
        translations: [
          { id: "2", text: "二" },
          { id: "1", text: "一" },
        ],
      },
      ["1", "2"],
    ).map((t) => t.id),
    ["2", "1"],
  );
});
test("batch application protects manual edits, reviewed rows, changed context and changed guidance", () => {
  const p = project();
  const event: TranslationBatchEvent = {
    type: "translationBatch",
    projectId: p.id,
    requestId: crypto.randomUUID(),
    language: p.language,
    targetLanguage: p.targetLanguage,
    guidanceKey: guidanceKey(p),
    originals: structuredClone(p.captions),
    evidence: p.captions.map((c) => ({ id: c.id, source: c.source })),
    model: "test",
    results: p.captions.map((c) => ({ id: c.id, text: "译文", issues: [] })),
  };
  const edited = structuredClone(p);
  edited.captions[0].target = "My edit";
  assert.equal(
    applyTranslationBatch(edited, event).project.captions[0].target,
    "My edit",
  );
  assert.equal(applyTranslationBatch(edited, event).applied, 1);
  const changed = structuredClone(p);
  changed.captions[1].source = "Different context";
  assert.equal(applyTranslationBatch(changed, event).applied, 0);
  const guide = approveGuidance(p, {
    ...emptyGuidance(),
    description: "Changed",
  });
  assert.equal(applyTranslationBatch(guide, event).applied, 0);
  const reviewed = structuredClone(p);
  reviewed.captions[0].status = "reviewed";
  assert.equal(
    applyTranslationBatch(reviewed, event).project.captions[0].target,
    "",
  );
  assert.equal(
    applyTranslationBatch(p, event).project.captions[0].start,
    p.captions[0].start,
  );
});
test("approved guidance and legacy project data persist; term changes invalidate affected translations", async () => {
  const p = project();
  p.captions.forEach((c) => {
    c.target = "译文";
    c.status = "reviewed";
  });
  const approved = {
    ...emptyGuidance(),
    terms: [
      {
        source: "WhisperX",
        target: "WhisperX",
        note: "Keep product name",
        captionIds: ["1"],
      },
    ],
  };
  const updated = approveGuidance(p, approved);
  assert.equal(updated.captions[0].status, "stale");
  assert.equal(updated.captions[1].status, "reviewed");
  const analysis = {
    description: "Suggested description",
    tone: "Technical",
    terms: [],
    ambiguities: [],
    sources: p.captions.map((c) => ({ id: c.id, text: c.source })),
    language: p.language,
    targetLanguage: p.targetLanguage,
    model: "test",
    createdAt: new Date().toISOString(),
  };
  updated.translationContext!.analysis = analysis;
  assert.equal(updated.translationContext!.approved.description, "");
  const dir = await mkdtemp(path.join(tmpdir(), "raccoon-context-"));
  try {
    const file = path.join(dir, "context.captionproj");
    await writeProject(file, updated);
    assert.deepEqual(await readProject(file), updated);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("real HTTP translation retries malformed mappings, checks meaning and carries approved guidance", async () => {
  const p = approveGuidance(project(), {
    ...emptyGuidance(),
    description: "Speech tutorial",
    terms: [
      { source: "model", target: "模型", note: "ASR model", captionIds: ["2"] },
    ],
  });
  const events: Event[] = [];
  await provider(
    (body, count) => {
      if (count === 1)
        return response({
          translations: [{ id: "wrong", text: "Bad mapping" }],
        });
      const input = JSON.parse(body.messages[1].content);
      if (input.proposedTranslations)
        return response({
          reviews: p.captions.map((c) => ({
            id: c.id,
            text: "核对后的译文",
            issues: c.id === "2" ? ["Check the intended model reference."] : [],
          })),
        });
      return response({
        translations: p.captions.map((c) => ({ id: c.id, text: "初稿" })),
      });
    },
    async (settings, requests) => {
      await translateProject(
        p,
        crypto.randomUUID(),
        options,
        settings,
        new AbortController().signal,
        () => {},
        (e) => events.push(e),
      );
      assert.equal(requests.length, 3);
      assert.equal(
        JSON.parse(requests[0].messages[1].content).approvedGuidance.terms[0]
          .target,
        "模型",
      );
      const event = events[0] as TranslationBatchEvent;
      assert.equal(event.results[0].text, "核对后的译文");
      assert.equal(event.results[1].issues[0].kind, "meaning");
      assert.equal(
        applyTranslationBatch(p, event).project.captions[0].status,
        "draft",
      );
    },
  );
});
test("authentication failures stop immediately and cancellation never applies incomplete batches", async () => {
  await provider(
    () => ({ status: 401 }),
    async (settings, requests) => {
      const events: Event[] = [];
      await assert.rejects(
        translateProject(
          project(),
          "request",
          options,
          settings,
          new AbortController().signal,
          () => {},
          (e) => events.push(e),
        ),
        /401/,
      );
      assert.equal(requests.length, 1);
      assert.match(
        (events[0] as TranslationBatchEvent).results[0].error!,
        /401/,
      );
    },
  );
  const abort = new AbortController();
  await provider(
    () => {
      abort.abort();
      return { wait: true };
    },
    async (settings) => {
      const events: Event[] = [];
      await assert.rejects(
        translateProject(
          project(),
          "request",
          options,
          settings,
          abort.signal,
          () => {},
          (e) => events.push(e),
        ),
      );
      assert.equal(events.length, 0);
    },
  );
});
test("readability flags are deterministic and do not rewrite text or timing", () => {
  const issues = readabilityIssues(
    "这是一段非常长而且需要更多时间才能够完整阅读的中文字幕",
    1,
    "Chinese",
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.kind === "readability"));
  assert.deepEqual(readabilityIssues("你好", 2, "Chinese"), []);
});

test("transient HTTP failures retry and a failed meaning check retains a flagged draft", async () => {
  const p = project();
  await provider(
    (body, count) => {
      if (count === 1) return { status: 429 };
      if (JSON.parse(body.messages[1].content).proposedTranslations)
        return response({ reviews: [] });
      return response({
        translations: p.captions.map((c) => ({ id: c.id, text: "初稿" })),
      });
    },
    async (settings, requests) => {
      const events: Event[] = [];
      await translateProject(
        p,
        "request",
        options,
        settings,
        new AbortController().signal,
        () => {},
        (e) => events.push(e),
      );
      assert.equal(requests.length, 5);
      const event = events[0] as TranslationBatchEvent;
      assert.equal(event.results[0].text, "初稿");
      assert.match(event.results[0].issues[0].message, /Meaning check failed/);
    },
  );
});

test("cancelling a later batch retains completed drafts and retry skips them", async () => {
  const p = {
    ...project(),
    captions: Array.from({ length: 12 }, (_, i) =>
      caption(String(i), "A full sentence."),
    ),
  };
  const abort = new AbortController();
  await provider(
    (body, count) => {
      if (count === 2) {
        abort.abort();
        return { wait: true };
      }
      return response({
        translations: JSON.parse(
          body.messages[1].content,
        ).captionsToTranslate.map((c: Caption) => ({ id: c.id, text: "译文" })),
      });
    },
    async (settings) => {
      const events: Event[] = [];
      await assert.rejects(
        translateProject(
          p,
          "request",
          { ...options, checkMeaning: false },
          settings,
          abort.signal,
          () => {},
          (e) => events.push(e),
        ),
      );
      assert.equal(events.length, 1);
      const result = applyTranslationBatch(
        p,
        events[0] as TranslationBatchEvent,
      );
      assert.equal(result.applied, 10);
      assert.equal(
        translationBatches(result.project, options).flatMap((b) => b.captions)
          .length,
        2,
      );
    },
  );
});

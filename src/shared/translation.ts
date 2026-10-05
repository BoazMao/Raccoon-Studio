import { z } from "zod";
import type { Caption, Project } from "./model";
import { guidanceKey } from "./context";

export const TranslationIssueSchema = z.object({
  kind: z.enum(["meaning", "readability"]),
  message: z.string().min(1).max(1200),
});
export const TranslationMetaSchema = z.object({
  origin: z.enum(["ai", "manual"]),
  model: z.string().optional(),
  createdAt: z.string().optional(),
  issues: z.array(TranslationIssueSchema).max(30).default([]),
});
export const TranslationOptionsSchema = z.object({
  mode: z.enum(["needed", "selected", "replace"]).default("needed"),
  ids: z.array(z.string()).default([]),
  checkMeaning: z.boolean().default(true),
});
export type TranslationOptions = z.infer<typeof TranslationOptionsSchema>;
export type TranslationIssue = z.infer<typeof TranslationIssueSchema>;
export type TranslationBatch = {
  captions: Caption[];
  before: Caption[];
  after: Caption[];
};
export type TranslationResult = {
  id: string;
  text: string;
  issues: TranslationIssue[];
  error?: string;
};
export type TranslationBatchEvent = {
  type: "translationBatch";
  projectId: string;
  requestId: string;
  targetLanguage: string;
  language: string;
  guidanceKey: string;
  originals: Caption[];
  evidence: { id: string; source: string }[];
  results: TranslationResult[];
  model: string;
};
export function translationBatches(
  p: Project,
  options: TranslationOptions,
): TranslationBatch[] {
  const all = [...p.captions].sort((a, b) => a.start - b.start);
  const selected = new Set(options.ids);
  const eligible = (c: Caption) =>
    c.source.trim() &&
    c.status !== "reviewed" &&
    (options.mode === "replace" ||
      (options.mode === "selected"
        ? selected.has(c.id)
        : ["empty", "stale", "failed"].includes(c.status)));
  const batches: TranslationBatch[] = [];
  let captions: Caption[] = [],
    start = 0,
    end = 0,
    chars = 0;
  const flush = () => {
    if (captions.length)
      batches.push({
        captions,
        before: all.slice(Math.max(0, start - 3), start),
        after: all.slice(end + 1, end + 4),
      });
    captions = [];
    chars = 0;
  };
  all.forEach((c, i) => {
    if (!eligible(c)) {
      flush();
      return;
    }
    if (c.source.length > 12000)
      throw Error("A caption is too long to translate safely. Split it first.");
    if (
      captions.length &&
      (chars + c.source.length > 9000 || captions.length >= 20)
    )
      flush();
    if (!captions.length) start = i;
    captions.push(c);
    end = i;
    chars += c.source.length;
    if (captions.length >= 10 && /[.!?。！？][\s"'”’]*$/.test(c.source))
      flush();
  });
  flush();
  return batches;
}
export function validateTranslations(value: unknown, ids: string[]) {
  const parsed = z
    .object({
      translations: z
        .array(
          z.object({
            id: z.string(),
            text: z.string().trim().min(1).max(20000),
          }),
        )
        .max(20),
    })
    .parse(value);
  const actual = parsed.translations.map((t) => t.id);
  if (
    actual.length !== ids.length ||
    new Set(actual).size !== ids.length ||
    actual.some((id) => !ids.includes(id))
  )
    throw Error(
      "Return every requested caption ID exactly once, with no extra IDs.",
    );
  return parsed.translations;
}
export function readabilityIssues(
  text: string,
  duration: number,
  targetLanguage: string,
): TranslationIssue[] {
  const chinese = /chinese|^zh/i.test(targetLanguage);
  const length = (s: string) =>
    [...s.replace(chinese ? /\s/g : /[\r\n]/g, "")].length;
  const lines = text.split(/\r?\n/),
    issues: TranslationIssue[] = [];
  if (lines.length > 2)
    issues.push({
      kind: "readability",
      message: "More than two subtitle lines.",
    });
  const lineLimit = chinese ? 16 : 42;
  if (lines.some((line) => length(line) > lineLimit))
    issues.push({
      kind: "readability",
      message: `Line exceeds the ${lineLimit}-character guide; consider a line break or shorter wording.`,
    });
  const speed = length(text) / duration,
    speedLimit = chinese ? 9 : 20;
  if (speed > speedLimit)
    issues.push({
      kind: "readability",
      message: `${speed.toFixed(1)} characters/second exceeds the ${speedLimit} characters/second guide.`,
    });
  return issues;
}
export function applyTranslationBatch(
  p: Project,
  e: TranslationBatchEvent,
): { project: Project; applied: number; skipped: number } {
  const unchanged =
    p.id === e.projectId &&
    p.language === e.language &&
    p.targetLanguage === e.targetLanguage &&
    guidanceKey(p) === e.guidanceKey;
  const current = new Map(p.captions.map((c) => [c.id, c]));
  if (
    !unchanged ||
    e.evidence.some((c) => current.get(c.id)?.source !== c.source)
  )
    return { project: p, applied: 0, skipped: e.results.length };
  const original = new Map(e.originals.map((c) => [c.id, c]));
  const results = new Map(e.results.map((c) => [c.id, c]));
  let applied = 0,
    skipped = 0;
  const captions = p.captions.map((c) => {
    const result = results.get(c.id),
      before = original.get(c.id);
    if (!result || !before) return c;
    if (
      c.source !== before.source ||
      c.target !== before.target ||
      c.status !== before.status ||
      c.status === "reviewed"
    ) {
      skipped++;
      return c;
    }
    applied++;
    if (result.error)
      return { ...c, status: "failed" as const, error: result.error };
    return {
      ...c,
      target: result.text,
      status: "draft" as const,
      error: undefined,
      translation: {
        origin: "ai" as const,
        model: e.model,
        createdAt: new Date().toISOString(),
        issues: [
          ...result.issues.filter((i) => i.kind !== "readability"),
          ...readabilityIssues(result.text, c.end - c.start, p.targetLanguage),
        ],
      },
    };
  });
  return { project: applied ? { ...p, captions } : p, applied, skipped };
}

import { z } from "zod";
import type { Project } from "./model";

export const ContextTermSchema = z.object({
  source: z.string().trim().min(1).max(200),
  target: z.string().trim().min(1).max(300),
  note: z.string().max(600).default(""),
  captionIds: z.array(z.string()).max(5).default([]),
});
export const GuidanceSchema = z.object({
  chineseVariant: z.enum(["Simplified", "Traditional"]).default("Simplified"),
  description: z.string().max(3000).default(""),
  tone: z.string().max(600).default(""),
  terms: z.array(ContextTermSchema).max(100).default([]),
});
export const ContextSuggestionsSchema = z.object({
  description: z.string().trim().max(3000),
  tone: z.string().trim().max(600),
  terms: z.array(ContextTermSchema).max(40),
  ambiguities: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(800),
        captionIds: z.array(z.string()).min(1).max(5),
      }),
    )
    .max(20),
});
export const ContextAnalysisSchema = ContextSuggestionsSchema.extend({
  sources: z.array(z.object({ id: z.string(), text: z.string() })),
  language: z.string(),
  targetLanguage: z.string(),
  model: z.string(),
  createdAt: z.string(),
});
export const TranslationContextSchema = z.object({
  approved: GuidanceSchema,
  // Retain legacy saved suggestions for project compatibility; no analysis job or UI.
  analysis: ContextAnalysisSchema.optional(),
});
export type Guidance = z.infer<typeof GuidanceSchema>;
export type ContextAnalysis = z.infer<typeof ContextAnalysisSchema>;
export type ContextSuggestions = z.infer<typeof ContextSuggestionsSchema>;
export const emptyGuidance = (): Guidance => ({
  chineseVariant: "Simplified",
  description: "",
  tone: "",
  terms: [],
});
export function guidanceKey(p: Project) {
  const g = p.translationContext?.approved || emptyGuidance();
  return JSON.stringify([
    g.chineseVariant,
    g.description,
    g.tone,
    g.terms.map((t) => [t.source, t.target, t.note]),
  ]);
}
export function approveGuidance(p: Project, input: Guidance): Project {
  const approved = GuidanceSchema.parse(input);
  if (JSON.stringify(approved).length > 16000)
    throw Error(
      "Guidance is too long. Keep the description and glossary under 16,000 characters combined.",
    );
  const keys = approved.terms.map((t) => t.source.toLocaleLowerCase());
  if (new Set(keys).size !== keys.length)
    throw Error("Each glossary term must appear only once.");
  const previous = p.translationContext?.approved || emptyGuidance();
  const globalChange =
    previous.description !== approved.description ||
    previous.tone !== approved.tone ||
    previous.chineseVariant !== approved.chineseVariant;
  const changedTerms = [...previous.terms, ...approved.terms].filter((t) => {
    const before = previous.terms.find((x) => x.source === t.source);
    const after = approved.terms.find((x) => x.source === t.source);
    return before?.target !== after?.target || before?.note !== after?.note;
  });
  return {
    ...p,
    translationContext: { ...p.translationContext, approved },
    captions: p.captions.map((c) =>
      c.target &&
      (globalChange ||
        changedTerms.some((t) =>
          c.source.toLocaleLowerCase().includes(t.source.toLocaleLowerCase()),
        ))
        ? { ...c, status: "stale" as const }
        : c,
    ),
  };
}

export function changeLanguages(
  p: Project,
  language: string,
  targetLanguage: string,
): Project {
  if (p.language === language && p.targetLanguage === targetLanguage) return p;
  return {
    ...p,
    language,
    targetLanguage,
    translationContext: p.translationContext
      ? { approved: { ...p.translationContext.approved, terms: [] } }
      : undefined,
    captions: p.captions.map((c) => ({
      ...c,
      status: c.target ? "stale" : "empty",
    })),
  };
}

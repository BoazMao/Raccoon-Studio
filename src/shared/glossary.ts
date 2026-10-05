import { z } from "zod";
import { ContextTermSchema, type Guidance } from "./context";

export const GlossaryScopeSchema = z.object({
  sourceLanguage: z.enum(["en", "zh"]),
  targetLanguage: z.enum(["English", "Chinese"]),
  chineseVariant: z.enum(["Simplified", "Traditional"]),
});
export const GlossaryFileSchema = GlossaryScopeSchema.extend({
  format: z.literal("raccoon-studio-glossary"),
  version: z.literal(1),
  terms: z.array(ContextTermSchema.omit({ captionIds: true })).max(100),
}).superRefine((value, ctx) => {
  const keys = value.terms.map((t) => t.source.toLowerCase());
  if (new Set(keys).size !== keys.length)
    ctx.addIssue({
      code: "custom",
      message: "The glossary contains duplicate source terms.",
    });
  if (JSON.stringify(value.terms).length > 16000)
    ctx.addIssue({
      code: "custom",
      message:
        "The glossary exceeds 16,000 characters. Split it into smaller glossaries.",
    });
});
export type GlossaryScope = z.infer<typeof GlossaryScopeSchema>;
export type GlossaryFile = z.infer<typeof GlossaryFileSchema>;
export function sameGlossaryScope(a: GlossaryScope, b: GlossaryScope) {
  return (
    a.sourceLanguage === b.sourceLanguage &&
    a.targetLanguage === b.targetLanguage &&
    (a.targetLanguage !== "Chinese" || a.chineseVariant === b.chineseVariant)
  );
}
export function portableGlossary(
  scope: GlossaryScope,
  terms: Guidance["terms"],
): GlossaryFile {
  return GlossaryFileSchema.parse({
    ...scope,
    format: "raccoon-studio-glossary",
    version: 1,
    terms,
  });
}
export function mergeGlossaryTerms(
  current: Guidance["terms"],
  incoming: GlossaryFile["terms"],
  replace: boolean,
) {
  const result = current.map((t) => ({ ...t }));
  let added = 0,
    updated = 0,
    kept = 0;
  for (const term of incoming) {
    const index = result.findIndex(
      (t) => t.source.trim().toLowerCase() === term.source.toLowerCase(),
    );
    if (index < 0) {
      result.push({ ...term, captionIds: [] });
      added++;
    } else if (replace) {
      result[index] = { ...term, captionIds: result[index].captionIds };
      updated++;
    } else kept++;
  }
  if (result.length > 100)
    throw Error(
      "A project glossary can contain at most 100 terms. Remove some terms before importing.",
    );
  return { terms: result, added, updated, kept };
}

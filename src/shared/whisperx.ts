import { z } from "zod";
import {
  CaptionSchema,
  type Caption,
  type Project,
  type SpeechRun,
} from "./model";
const Unit = z.object({
  text: z.string(),
  start: z.number().finite().nullable(),
  end: z.number().finite().nullable(),
  confidence: z.number().finite().nullable(),
});
export const WhisperXResult = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  language: z.enum(["en", "zh"]),
  segments: z.array(
    z.object({
      id: z.string().nullable().optional(),
      start: z.number().finite().nonnegative().nullable(),
      end: z.number().finite().nonnegative().nullable(),
      text: z.string(),
      units: z.array(Unit),
      recognitionLogprob: z.number().finite().nullable().optional(),
      window: z.object({ start: z.number(), end: z.number() }).optional(),
    }),
  ),
});
export function importWhisperX(
  input: unknown,
  duration: number,
  originals?: Caption[],
  neighbors: Caption[] = [],
): Caption[] {
  const result = WhisperXResult.parse(input);
  const bounds: { start: number; end: number; aligned: boolean }[] = [];
  const output: Caption[] = [];
  for (const segment of result.segments) {
    const original = originals?.find((c) => c.id === segment.id);
    if (originals && !original)
      throw Error("Alignment returned an unknown caption ID");
    if (!segment.text.trim()) continue;
    const timed = segment.units.filter(
      (u) =>
        u.start !== null &&
        u.end !== null &&
        u.start >= 0 &&
        u.end >= u.start &&
        u.end <= duration,
    );
    const missing = segment.units
      .filter((u) => !timed.includes(u))
      .map((u) => u.text);
    const complete =
      timed.length > 0 &&
      !missing.length &&
      segment.units
        .map((u) => u.text)
        .join("")
        .replace(/\s/g, "") === segment.text.replace(/\s/g, "");
    let start = segment.start,
      end = segment.end;
    // v1 compatibility only: older worker results used coarse ASR boundaries.
    if (result.version === 1 && complete) {
      start = timed[0].start;
      end = timed.at(-1)!.end;
    }
    const aligned =
      start !== null &&
      end !== null &&
      start >= 0 &&
      end > start &&
      end <= duration;
    if (!aligned) {
      start = original?.start ?? segment.window?.start ?? segment.start;
      end = original?.end ?? segment.window?.end ?? segment.end;
    }
    if (
      start === null ||
      start === undefined ||
      end === null ||
      end === undefined ||
      start < 0 ||
      start >= duration ||
      end <= start
    )
      throw Error(
        "Alignment has no usable caption window. Raw output must be retained for review.",
      );
    end = Math.min(duration, end);
    bounds.push({ start, end, aligned });
    output.push(
      CaptionSchema.parse({
        ...(original || {
          id: crypto.randomUUID(),
          target: "",
          status: "empty",
        }),
        source: original?.source ?? segment.text,
        ...(!original && segment.recognitionLogprob != null
          ? {
              recognition: {
                avgLogprob: segment.recognitionLogprob,
                needsReview: segment.recognitionLogprob < -1,
              },
            }
          : {}),
        start: aligned ? Math.max(0, start - 0.05) : start,
        end: aligned ? Math.min(duration, end + 0.05) : end,
        alignment: {
          method: "whisperx",
          needsReview:
            !aligned ||
            !complete ||
            timed.some(
              (u, i) =>
                (u.confidence ?? 0) < 0.35 ||
                (i > 0 && u.start! < timed[i - 1].end!),
            ),
          missingWords: missing.length
            ? missing
            : !complete || !aligned
              ? ["Alignment incomplete"]
              : [],
          tokens: timed.map((u, i) => ({
            text: (i && result.language === "en" ? " " : "") + u.text,
            start: u.start!,
            end: u.end!,
            confidence: Math.max(0, Math.min(1, u.confidence ?? 0)),
          })),
        },
      }),
    );
  }
  // Padding shares the actual gap. Never trim an overlapping speech interval.
  const ordered = output
    .map((caption, i) => ({ caption, bound: bounds[i] }))
    .sort((a, b) => a.bound.start - b.bound.start);
  for (const c of neighbors) {
    if (!originals?.some((o) => o.id === c.id))
      ordered.push({
        caption: { ...c },
        bound: { start: c.start, end: c.end, aligned: false },
      });
  }
  ordered.sort((a, b) => a.bound.start - b.bound.start);
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1],
      b = ordered[i];
    if (a.bound.end <= b.bound.start && a.caption.end > b.caption.start) {
      const midpoint = (a.bound.end + b.bound.start) / 2;
      if (a.bound.aligned) a.caption.end = Math.min(a.caption.end, midpoint);
      if (b.bound.aligned)
        b.caption.start = Math.max(b.caption.start, midpoint);
    }
  }
  if (
    originals &&
    (output.length !== originals.length ||
      new Set(output.map((c) => c.id)).size !== originals.length)
  )
    throw Error("Alignment did not return every selected caption");
  return output;
}

export function applyTranscription(
  current: Project,
  captions: Caption[],
  mode: "replace" | "add",
  originals: Caption[],
  speechRun?: SpeechRun,
): { project: Project; blocked: boolean } {
  const blocked =
    !!speechRun?.importError ||
    (mode === "replace" &&
      (current.captions.length !== originals.length ||
        current.captions.some((c) => {
          const before = originals.find((o) => o.id === c.id);
          return (
            !before ||
            JSON.stringify(CaptionSchema.parse(c)) !==
              JSON.stringify(CaptionSchema.parse(before))
          );
        })));
  return {
    blocked,
    project: {
      ...current,
      speechRuns: speechRun
        ? [...(current.speechRuns || []), speechRun]
        : current.speechRuns,
      captions: blocked
        ? current.captions
        : (mode === "replace"
            ? captions
            : [...current.captions, ...captions]
          ).sort((a, b) => a.start - b.start),
    },
  };
}

export function applyRealignment(
  current: Caption[],
  originals: Caption[],
  aligned: Caption[],
): Caption[] {
  return current.map((c) => {
    const before = originals.find((x) => x.id === c.id),
      after = aligned.find((x) => x.id === c.id);
    if (
      !before ||
      !after ||
      c.source !== before.source ||
      c.start !== before.start ||
      c.end !== before.end
    )
      return c;
    return {
      ...c,
      start: after.start,
      end: after.end,
      alignment: after.alignment,
    };
  });
}

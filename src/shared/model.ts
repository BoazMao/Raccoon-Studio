import { z } from "zod";
import { WaveformSchema } from "./waveform";
import { TranslationContextSchema } from "./context";
import { TranslationMetaSchema } from "./translation";
export const CaptionSchema = z
  .object({
    id: z.string().min(1),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    source: z.string(),
    target: z.string(),
    status: z.enum(["empty", "draft", "reviewed", "stale", "failed"]),
    error: z.string().optional(),
    translation: TranslationMetaSchema.optional(),
    alignment: z
      .object({
        method: z.enum(["whisper-dtw", "whisperx"]),
        missingWords: z.array(z.string()).optional(),
        needsReview: z.boolean(),
        tokens: z.array(
          z.object({
            text: z.string(),
            start: z.number().finite().nonnegative(),
            end: z.number().finite().nonnegative(),
            confidence: z.number().finite().min(0).max(1),
          }),
        ),
      })
      .optional(),
  })
  .refine((c) => c.end > c.start, "Caption end must follow start");
export const SpeechRunSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  mode: z.enum(["transcription", "realignment"]),
  raw: z.record(z.unknown()),
  importError: z.string().optional(),
  captions: z.array(CaptionSchema),
});
export type SpeechRun = z.infer<typeof SpeechRunSchema>;
export const ProjectSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    name: z.string(),
    media: z
      .object({
        path: z.string(),
        previewPath: z.string().optional(),
        duration: z.number().finite().nonnegative(),
        fps: z.number().finite().positive(),
      })
      .nullable(),
    language: z.string(),
    targetLanguage: z.string(),
    speechRuns: z.array(SpeechRunSchema).optional(),
    waveform: WaveformSchema.optional().catch(undefined),
    translationContext: TranslationContextSchema.optional(),
    captions: z.array(CaptionSchema),
  })
  .superRefine((p, ctx) => {
    if (new Set(p.captions.map((c) => c.id)).size !== p.captions.length)
      ctx.addIssue({ code: "custom", message: "Duplicate caption IDs" });
  });
export type Caption = z.infer<typeof CaptionSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export const blank = (): Project => ({
  version: 1,
  id: crypto.randomUUID(),
  name: "Untitled project",
  media: null,
  language: "en",
  targetLanguage: "Chinese",
  captions: [],
});
export function sourceEdit(c: Caption, source: string): Caption {
  return {
    ...c,
    source,
    status: source === c.source ? c.status : c.target ? "stale" : "empty",
    error: undefined,
    alignment:
      source === c.source || !c.alignment
        ? c.alignment
        : { ...c.alignment, needsReview: true },
  };
}
export function timing(
  c: Caption,
  start: number,
  end: number,
  duration = Infinity,
): Caption {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end - start < 0.04 ||
    end > duration + 0.001
  )
    throw Error("Timing must be within the video and at least 40 ms long");
  return {
    ...c,
    start,
    end,
    alignment:
      (start === c.start && end === c.end) || !c.alignment
        ? c.alignment
        : { ...c.alignment, needsReview: true },
  };
}
export function split(c: Caption, at: number, id: string): Caption[] {
  if (at - c.start < 0.04 || c.end - at < 0.04)
    throw Error("Place the playhead inside the caption");
  c = { ...c, translation: undefined, error: undefined };
  const aligned = c.alignment?.needsReview ? undefined : c.alignment?.tokens;
  if (aligned && aligned.length > 1) {
    const boundaries = aligned.slice(1).flatMap((token, i) =>
      /^\s/.test(token.text) || /[\u3400-\u9fff]/.test(c.source)
        ? [
            {
              index: i + 1,
              time: (aligned[i].end + token.start) / 2,
            },
          ]
        : [],
    );
    const valid = boundaries.filter(
      (b) => b.time - c.start >= 0.04 && c.end - b.time >= 0.04,
    );
    const closest = valid.sort(
      (a, b) => Math.abs(a.time - at) - Math.abs(b.time - at),
    )[0];
    if (closest) {
      const first = aligned.slice(0, closest.index);
      const second = aligned.slice(closest.index);
      return [
        {
          ...c,
          end: closest.time,
          source: first
            .map((t) => t.text)
            .join("")
            .trim(),
          target: "",
          status: "empty",
          alignment: { ...c.alignment!, tokens: first },
        },
        {
          ...c,
          id,
          start: closest.time,
          source: second
            .map((t) => t.text)
            .join("")
            .trim(),
          target: "",
          status: "empty",
          alignment: { ...c.alignment!, tokens: second },
        },
      ];
    }
  }
  const words = c.source.split(" "),
    cut = Math.max(
      1,
      Math.round((words.length * (at - c.start)) / (c.end - c.start)),
    );
  return [
    {
      ...c,
      end: at,
      source: words.slice(0, cut).join(" "),
      target: "",
      status: "empty",
      alignment: c.alignment
        ? { ...c.alignment, needsReview: true }
        : undefined,
    },
    {
      ...c,
      id,
      start: at,
      source: words.slice(cut).join(" "),
      target: "",
      status: "empty",
      alignment: c.alignment
        ? { ...c.alignment, needsReview: true }
        : undefined,
    },
  ];
}
export function merge(a: Caption, b: Caption): Caption {
  return {
    ...a,
    translation: undefined,
    error: undefined,
    start: Math.min(a.start, b.start),
    end: Math.max(a.end, b.end),
    source: [a.source, b.source].filter(Boolean).join(" "),
    target: [a.target, b.target].filter(Boolean).join(" "),
    status: a.target || b.target ? "stale" : "empty",
    alignment: undefined,
  };
}
export function translated(
  c: Caption,
  original: string,
  text: string,
  error?: string,
  originalTarget?: string,
): Caption {
  // A response must not replace a manual edit made while it was in flight.
  if (originalTarget !== undefined && c.target !== originalTarget) return c;
  if (c.source !== original)
    return { ...c, status: c.target ? "stale" : "empty" };
  return {
    ...c,
    target: error ? c.target : text,
    status: error ? "failed" : "draft",
    error,
  };
}
export function stamp(s: number) {
  const n = Math.round(s * 1000);
  return `${String(Math.floor(n / 3600000)).padStart(2, "0")}:${String(Math.floor(n / 60000) % 60).padStart(2, "0")}:${String(Math.floor(n / 1000) % 60).padStart(2, "0")},${String(n % 1000).padStart(3, "0")}`;
}
export function srt(p: Project, track: "source" | "target") {
  ProjectSchema.parse(p);
  return [...p.captions]
    .sort((a, b) => a.start - b.start)
    .filter((c) => c[track].trim())
    .map(
      (c, i) =>
        `${i + 1}\r\n${stamp(c.start)} --> ${stamp(c.end)}\r\n${c[track].trim()}\r\n`,
    )
    .join("\r\n");
}
export function parseSrt(text: string): Caption[] {
  return text
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const lines = block.split("\n"),
        i = lines.findIndex((l) => l.includes("-->"));
      if (i < 0) return [];
      const time = (s: string) => {
        const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
        if (!m) throw Error("Invalid subtitle timestamp");
        return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      };
      const [a, b] = lines[i].split("-->");
      return [
        CaptionSchema.parse({
          id: crypto.randomUUID(),
          start: time(a),
          end: time(b),
          source: lines
            .slice(i + 1)
            .join("\n")
            .trim(),
          target: "",
          status: "empty",
        }),
      ];
    });
}

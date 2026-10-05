import { z } from "zod";

export const DownloadQualitySchema = z.union([
  z.literal("best"),
  z.number().int().min(1).max(16384),
]);
export type DownloadQuality = z.infer<typeof DownloadQualitySchema>;
export type VideoPreview = {
  title: string;
  duration: number;
  uploader: string;
  qualities: number[];
};
export function videoPreview(raw: unknown): VideoPreview {
  const m = z
    .object({
      title: z.unknown().optional(),
      duration: z.unknown().optional(),
      uploader: z.unknown().optional(),
      formats: z.array(z.unknown()).optional(),
    })
    .passthrough()
    .parse(raw);
  const heights = (m.formats || [m]).flatMap((format) => {
    if (!format || typeof format !== "object") return [];
    const f = format as Record<string, unknown>;
    if (f.vcodec === "none" || f.has_drm || f.format_note === "storyboard")
      return [];
    return typeof f.height === "number" &&
      Number.isInteger(f.height) &&
      f.height > 0 &&
      f.height <= 16384
      ? [f.height]
      : [];
  });
  return {
    title: String(m.title || "Untitled video"),
    duration: Math.max(0, Number(m.duration) || 0),
    uploader: String(m.uploader || ""),
    qualities: [...new Set(heights)].sort((a, b) => b - a),
  };
}
export function downloadFormat(input: unknown = "best") {
  const quality = DownloadQualitySchema.parse(input);
  const limit = quality === "best" ? "" : `[height<=${quality}]`;
  return `bv*${limit}+ba/b${limit}/bv${limit}`;
}

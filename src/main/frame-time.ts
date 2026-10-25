import { stat } from "node:fs/promises";
import { run } from "./jobs";
export function neighboringFrame(
  frames: number[],
  time: number,
  direction: -1 | 1,
) {
  return direction === 1
    ? frames.find((t) => t > time + 0.001)
    : [...frames].reverse().find((t) => t < time - 0.001);
}
export class FrameTimes {
  private cached?: { key: string; from: number; to: number; frames: number[] };
  async step(file: string, time: number, direction: -1 | 1, ffprobe: string) {
    const info = await stat(file),
      key = JSON.stringify([file, info.size, info.mtimeMs, ffprobe]);
    if (
      !this.cached ||
      this.cached.key !== key ||
      time < this.cached.from + 0.1 ||
      time > this.cached.to - 0.1
    ) {
      const from = Math.max(0, time - 2),
        to = time + 2;
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 10000);
      try {
        const raw = JSON.parse(
          await run(
            ffprobe,
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-read_intervals",
              `${from}%${to}`,
              "-show_frames",
              "-show_format",
              "-show_entries",
              "frame=best_effort_timestamp_time:format=start_time",
              "-of",
              "json",
              file,
            ],
            controller.signal,
          ),
        );
        const origin = Number(raw.format?.start_time) || 0;
        const frames = (raw.frames || [])
          .map(
            (frame: { best_effort_timestamp_time?: string }) =>
              Number(frame.best_effort_timestamp_time) - origin,
          )
          .filter((t: number) => Number.isFinite(t) && t >= 0)
          .sort((a: number, b: number) => a - b);
        if (!frames.length)
          throw Error("No video frame timestamps were available");
        this.cached = { key, from, to: Math.max(...frames), frames };
      } finally {
        clearTimeout(timer);
      }
    }
    const next = neighboringFrame(this.cached.frames, time, direction);
    return next === undefined ? time : next + 0.000001;
  }
}

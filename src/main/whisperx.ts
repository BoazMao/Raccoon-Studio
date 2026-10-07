import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Caption, Project, SpeechRun } from "../shared/model";
import type { Settings } from "../shared/ipc";
import { importWhisperX } from "../shared/whisperx";
import { run } from "./jobs";
import {
  nextSpeechAttempt,
  WorkerFailureSchema,
  type WorkerFailure,
} from "../shared/speech-runtime";

export class SpeechJobError extends Error {
  constructor(
    message: string,
    readonly speechRun: SpeechRun,
  ) {
    super(message);
  }
}

export async function whisperXJob(
  p: Project | null,
  config: Settings,
  dir: string,
  worker: string,
  signal: AbortSignal,
  update: (n: number, message: string) => void,
  originals?: Caption[],
  execute: typeof run = run,
) {
  const audio = path.join(dir, "speech.wav"),
    output = path.join(dir, "aligned.json"),
    request = path.join(dir, "request.json");
  if (p?.media) {
    update(1, "Preparing audio");
    await execute(
      config.ffmpeg,
      [
        "-y",
        "-v",
        "error",
        "-i",
        p.media.path,
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        audio,
      ],
      signal,
    );
  }
  const baseRequest = {
    protocol: 2,
    requestedDevice: config.whisperxDevice,
    audio,
    output,
    model: config.whisperxModel,
    language: p?.language || "en",
    device: config.whisperxDevice,
    cache: config.whisperxCache,
    offline: config.whisperxOffline,
    check: !p,
    captions: originals,
    checkpoint: path.join(dir, "recognition.json"),
    precision: config.whisperxPrecision || "float16",
  };
  let attempt = {
    device: config.whisperxDevice,
    batch: config.whisperxBatchLimit || 4,
    alignmentCpu: false,
  };
  const fallbacks: { code: string; stage: string; message: string }[] = [];
  let failure: WorkerFailure | undefined;
  let effectiveBatch = attempt.batch;
  let pending = "";
  const lines = (text: string) => {
    pending += text;
    const parts = pending.split(/\r?\n/);
    pending = parts.pop() || "";
    for (const line of parts)
      if (line.startsWith("STUDIO:")) {
        try {
          const e = JSON.parse(line.slice(7));
          const failed = WorkerFailureSchema.safeParse(e);
          if (failed.success) failure = failed.data;
          if (
            e.type === "execution" &&
            Number.isInteger(e.batch) &&
            e.batch > 0 &&
            e.batch <= 64
          )
            effectiveBatch = e.batch;
          if (typeof e.progress === "number" && typeof e.message === "string")
            update(Math.min(100, Math.max(0, e.progress)), e.message);
        } catch {
          /* Other Python output is diagnostic only. */
        }
      }
  };
  for (let retries = 0; ; retries++) {
    signal.throwIfAborted();
    failure = undefined;
    pending = "";
    await writeFile(
      request,
      JSON.stringify({
        ...baseRequest,
        device: attempt.device,
        batchLimit: attempt.batch,
        alignmentCpu: attempt.alignmentCpu,
        resume: retries > 0,
        fallbacks,
      }),
      "utf8",
    );
    try {
      await execute(
        config.whisperxPython,
        ["-u", worker, request],
        signal,
        () => {},
        (data) => lines(data.toString("utf8")),
      );
      break;
    } catch (error) {
      const next =
        !signal.aborted && failure && retries < 6
          ? nextSpeechAttempt(failure, config.whisperxDevice, {
              ...attempt,
              batch: effectiveBatch,
            })
          : undefined;
      if (!next) {
        const recognition = await readFile(baseRequest.checkpoint, "utf8")
          .then(JSON.parse)
          .catch(() => null);
        const alignments = await readFile(
          path.join(dir, "alignment-checkpoint.jsonl"),
          "utf8",
        )
          .then((text) =>
            text.split(/\r?\n/).flatMap((line) => {
              try {
                return line ? [JSON.parse(line)] : [];
              } catch {
                return [];
              }
            }),
          )
          .catch(() => []);
        if (p && (recognition || alignments.length)) {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new SpeechJobError(message, {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            mode: originals ? "realignment" : "transcription",
            captions: [],
            importError: message,
            raw: {
              transcription: recognition?.transcription ?? null,
              alignments,
              model: config.whisperxModel,
              correctedCaptions: originals ?? null,
              execution: recognition?.execution ?? null,
              failure: failure ?? null,
              fallbacks,
              cancelled: signal.aborted,
            },
          });
        }
        throw error;
      }
      fallbacks.push({ ...failure! });
      attempt = next;
      effectiveBatch = next.batch;
      update(
        18,
        next.device === "cpu"
          ? "GPU unavailable; continuing on CPU with the same model"
          : next.alignmentCpu
            ? "GPU memory exhausted; retrying alignment on CPU"
            : `GPU memory exhausted; retrying batch ${next.batch}`,
      );
    }
  }
  signal.throwIfAborted();
  if (!p) return { captions: [], speechRun: undefined };
  const result = JSON.parse(await readFile(output, "utf8"));
  let captions: Caption[] = [],
    importError: string | undefined;
  try {
    captions = importWhisperX(
      result,
      p.media!.duration,
      originals,
      originals ? p.captions : [],
    );
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  const speechRun: SpeechRun = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    mode: originals ? "realignment" : "transcription",
    raw: result.raw ?? result,
    importError,
    captions: structuredClone(captions),
  };
  return { captions, speechRun };
}

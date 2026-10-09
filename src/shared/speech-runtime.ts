import { z } from "zod";

export const RuntimeProfileSchema = z.enum(["cpu", "cuda"]);
export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;
export type SpeechDevice = "auto" | "cpu" | "cuda";
export type SpeechRuntimeStatus = {
  profile?: RuntimeProfile;
  python?: string;
  installedAt?: string;
  verifiedAt?: string;
  runtimeBytes: number;
  previousBytes: number;
  cacheBytes: number;
  gpus: { index: number; name: string; memoryMiB: number; driver: string }[];
  detectionMessage?: string;
};
export const WorkerFailureSchema = z.object({
  type: z.literal("failure"),
  code: z.enum([
    "cuda_unavailable",
    "gpu_memory",
    "missing_library",
    "unsupported_precision",
    "runtime_error",
  ]),
  stage: z.enum(["runtime", "recognition", "alignment"]),
  message: z.string(),
});
export type WorkerFailure = z.infer<typeof WorkerFailureSchema>;

export function nextSpeechAttempt(
  failure: WorkerFailure,
  preference: SpeechDevice,
  attempt: {
    device: "auto" | "cpu" | "cuda";
    batch: number;
    alignmentCpu: boolean;
  },
): typeof attempt | undefined {
  if (
    failure.code === "gpu_memory" &&
    failure.stage === "recognition" &&
    attempt.device !== "cpu" &&
    attempt.batch > 1
  )
    return { ...attempt, batch: Math.max(1, Math.floor(attempt.batch / 2)) };
  if (
    failure.code === "gpu_memory" &&
    failure.stage === "alignment" &&
    preference === "auto" &&
    !attempt.alignmentCpu
  )
    return { ...attempt, alignmentCpu: true };
  if (
    preference === "auto" &&
    attempt.device !== "cpu" &&
    [
      "gpu_memory",
      "cuda_unavailable",
      "missing_library",
      "unsupported_precision",
    ].includes(failure.code)
  )
    return { device: "cpu", batch: 1, alignmentCpu: true };
}

import path from "node:path";
import { readdir } from "node:fs/promises";
import { managedRuntime, directoryBytes } from "./install-whisperx";
import { run } from "./jobs";
import type { SpeechRuntimeStatus } from "../shared/speech-runtime";

export async function speechStatus(root: string): Promise<SpeechRuntimeStatus> {
  const runtime = await managedRuntime(root);
  let runtimeBytes = 0,
    previousBytes = 0;
  for (const entry of await readdir(path.join(root, "environments"), {
    withFileTypes: true,
  }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    const directory = path.join(root, "environments", entry.name);
    const bytes = await directoryBytes(directory);
    if (runtime && directory === path.dirname(path.dirname(runtime.executable)))
      runtimeBytes = bytes;
    else previousBytes += bytes;
  }
  const status: SpeechRuntimeStatus = {
    profile: runtime?.profile,
    python: runtime?.executable,
    installedAt: runtime?.installedAt,
    verifiedAt: runtime?.verifiedAt,
    runtimeBytes,
    previousBytes,
    cacheBytes: await directoryBytes(path.join(root, "cache")),
    gpus: [],
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const csv = await run(
        "nvidia-smi.exe",
        [
          "--query-gpu=index,name,memory.total,driver_version",
          "--format=csv,noheader,nounits",
        ],
        controller.signal,
      );
      status.gpus = csv.split(/\r?\n/).flatMap((line) => {
        const match = line.match(/^\s*(\d+),\s*(.+),\s*(\d+),\s*([\d.]+)\s*$/);
        return match
          ? [
              {
                index: Number(match[1]),
                name: match[2],
                memoryMiB: Number(match[3]),
                driver: match[4],
              },
            ]
          : [];
      });
      if (!status.gpus.length)
        status.detectionMessage =
          "No NVIDIA GPU reported. CPU remains available.";
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    status.detectionMessage =
      "NVIDIA detection unavailable. Check setup to verify CUDA in the selected runtime.";
  }
  return status;
}

import React, { useEffect, useState } from "react";
import type { Bridge, Job, Settings } from "../shared/ipc";
import type {
  RuntimeProfile,
  SpeechRuntimeStatus,
} from "../shared/speech-runtime";

export function SpeechRuntimePanel({
  settings,
  onChange,
  jobs,
  api,
}: {
  settings: Settings;
  onChange: (settings: Settings) => void;
  jobs: Job[];
  api: Bridge;
}) {
  const [status, setStatus] = useState<SpeechRuntimeStatus>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const changes = jobs
    .filter((job) => job.kind.startsWith("WhisperX"))
    .map((job) => `${job.id}:${job.state}`)
    .join("|");
  const installing = jobs.some(
    (job) => job.kind === "WhisperX installation" && job.state === "running",
  );
  const cleaning = jobs.some(
    (job) => job.kind === "WhisperX cleanup" && job.state === "running",
  );
  async function refresh() {
    setLoading(true);
    try {
      setStatus(await api.call("speechRuntime", undefined));
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [changes]);
  async function action(fn: () => Promise<unknown>) {
    try {
      setError("");
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  const install = (profile: RuntimeProfile) =>
    action(async () => {
      await api.call("configure", settings);
      await api.call("installSpeech", { profile });
    });
  return (
    <div className="speech-runtime">
      <h4>Local speech runtime</h4>
      <p>
        {status?.profile
          ? `Installed: WhisperX 3.8.6 · ${status.profile.toUpperCase()}`
          : loading
            ? "Checking installed runtime…"
            : "No managed runtime installed"}
      </p>
      {status?.gpus.map((gpu) => (
        <p key={gpu.index}>
          {gpu.name} · {(gpu.memoryMiB / 1024).toFixed(1)} GiB VRAM · driver{" "}
          {gpu.driver}
        </p>
      ))}
      {status?.detectionMessage && <p>{status.detectionMessage}</p>}
      <p>
        CPU download: about 0.8 GiB. GPU download: about 3.5 GiB. Installation
        requires 6 GiB free for CPU or 12 GiB for GPU, including temporary
        files. Models download separately. CUDA also supports CPU operation.
      </p>
      <div className="speech-runtime-actions">
        <button
          disabled={installing || cleaning}
          onClick={() => void install("cpu")}
        >
          {installing ? "Installing WhisperX…" : "Install WhisperX"}
        </button>
        <button
          disabled={installing || cleaning}
          onClick={() => void install("cuda")}
        >
          Install GPU support
        </button>
        <button
          disabled={installing || cleaning}
          onClick={() =>
            void action(async () => {
              await api.call("configure", settings);
              await api.call("checkSpeech", undefined);
            })
          }
        >
          Check WhisperX setup
        </button>
        <button disabled={loading} onClick={() => void refresh()}>
          Refresh runtime status
        </button>
      </div>
      {status?.profile && (
        <>
          <p>
            Runtime {gib(status.runtimeBytes)} · previous installations{" "}
            {gib(status.previousBytes)} · installer cache{" "}
            {gib(status.cacheBytes)} (logical file sizes).{" "}
            {status.verifiedAt
              ? "Real transcription verified."
              : "Run a transcription to verify the models before cleaning previous versions."}
          </p>
          <button
            disabled={
              installing ||
              cleaning ||
              !status.verifiedAt ||
              !status.previousBytes
            }
            onClick={() =>
              void action(() => api.call("cleanupSpeech", undefined))
            }
          >
            Remove previous speech runtimes
          </button>
        </>
      )}
      <label>
        <input
          type="checkbox"
          checked={!settings.whisperxManaged}
          onChange={(e) =>
            onChange({ ...settings, whisperxManaged: !e.target.checked })
          }
        />
        Use a custom Python environment
      </label>
      <details>
        <summary>Advanced performance settings</summary>
        <label>
          Managed runtime folder (blank = app data)
          <input
            value={settings.whisperxRuntimeRoot || ""}
            disabled={installing || cleaning}
            onChange={(e) =>
              onChange({ ...settings, whisperxRuntimeRoot: e.target.value })
            }
          />
        </label>
        <button
          disabled={installing || cleaning}
          onClick={() =>
            void action(async () => {
              const folder = await api.call("pick", "folder");
              if (folder)
                onChange({ ...settings, whisperxRuntimeRoot: folder });
            })
          }
        >
          Choose runtime folder
        </button>
        <p>
          Choose another drive before installing if needed. Changing this folder
          does not move an existing installation. Save settings and refresh to
          inspect the selected folder.
        </p>
        <label>
          Maximum recognition batch (0 = automatic)
          <input
            type="number"
            min="0"
            max="16"
            value={settings.whisperxBatchLimit || 0}
            onChange={(e) =>
              onChange({
                ...settings,
                whisperxBatchLimit: Math.min(
                  16,
                  Math.max(0, Number(e.target.value)),
                ),
              })
            }
          />
        </label>
        <label>
          GPU precision
          <select
            value={settings.whisperxPrecision || "float16"}
            onChange={(e) =>
              onChange({
                ...settings,
                whisperxPrecision: e.target.value as "float16" | "int8_float16",
              })
            }
          >
            <option value="float16">FP16 (default)</option>
            <option value="int8_float16">
              INT8 / FP16 (lower memory; results may differ)
            </option>
          </select>
        </label>
        <p>
          Auto may retry on CPU when GPU memory or libraries are unavailable.
          Explicit GPU mode keeps your choice and reports failures. The selected
          model stays unchanged.
        </p>
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

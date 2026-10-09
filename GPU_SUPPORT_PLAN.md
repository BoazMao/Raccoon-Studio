# GPU support: project-wide implementation plan

Status: implemented and validated, 7 October 2026; hardware and unpackaged validation is recorded in VERIFICATION.md. No release has been published. The sections below retain the design rationale and original baseline observations.

## Decision

Keep upstream WhisperX as the primary speech engine. Add an optional, managed NVIDIA CUDA runtime using the existing private-Python/uv installer. Ship the editor separately from speech dependencies and models. Maintain CPU and CUDA installation profiles, but normally only one active installation: a verified CUDA installation should also execute CPU jobs.

Retain the bundled whisper.cpp CPU fallback as an explicitly selected alternative. Its output and alignment behavior differ, so a failed WhisperX job must never silently change engines.

This balances the project's priorities: reliable transcription and alignment, a responsive editor, straightforward installation, bounded disk usage, and a small maintenance surface. It does not optimize solely for the smallest dependency tree or the fastest benchmark.

## Evidence from the current project

- Electron, React, and shared TypeScript contracts are already separated. Subprocesses use argument arrays, `shell: false`, hidden windows, and process-tree cancellation.
- `src/main/install-whisperx.ts` installs private Python 3.12.14, CPU PyTorch/torchaudio 2.8.0, torchvision 0.23.0, WhisperX 3.8.6, and Transformers 4.57.6. It stages installations and atomically activates them. Successful old environments currently accumulate.
- Only selected dependencies are pinned. Many transitive dependencies are resolved at installation time. The manual setup script and managed installer also follow different installation paths.
- `scripts/whisperx_worker.py` already supports CUDA. Recognition uses FP16 and a fixed batch size of four; CPU uses INT8 and batch size one. Recognition is unloaded before alignment, which is worth preserving.
- The setup check imports modules and checks PyTorch CUDA availability. It does not demonstrate CTranslate2 CUDA inference or actual forced alignment.
- The main process starts jobs independently. The renderer uses a broad busy flag that includes translation, speech, downloads, and media tasks; this is not a resource scheduler.
- Every speech operation currently prepares a temporary 16 kHz mono WAV. Completed transcription is not checkpointed before alignment. Cancellation and failure remove the job directory.
- Project files preserve raw WhisperX outputs, imported caption snapshots, translations, review state, and a compressed waveform. These are valuable and must remain intact.
- The local development Python environment contains approximately **2.11 GiB of logical file data**, including **866.1 MiB in 20 PyTorch `.lib` files**. This is a local file inventory, not a measurement of a future CUDA runtime, download size, or physical allocated disk space.
- The available initial GPU test machine has an RTX 3060 Laptop GPU, 6 GiB VRAM, and driver 581.80. Passing on this machine alone is insufficient to claim broad hardware support.

Relevant implementation files: `src/main/install-whisperx.ts`, `src/main/whisperx.ts`, `src/main/jobs.ts`, `src/main/main.ts`, `src/shared/ipc.ts`, and `scripts/whisperx_worker.py`.

## Alternatives and tradeoffs

| Approach | Maintenance | Disk and distribution | Performance and workflow | Decision |
| --- | --- | --- | --- | --- |
| Managed upstream WhisperX, optional CPU/CUDA profiles | Reuses current integration and upstream fixes | Large optional runtime; small editor download; shared models | Accelerates recognition and alignment while preserving current behavior | Recommended |
| Bundle complete CUDA WhisperX in every app download | Same speech integration, heavier release maintenance | Everyone receives GPU libraries; repeated app downloads duplicate costs | Convenient after extraction, unsuitable for CPU-only users | Avoid as default |
| Require system Python and a user-managed CUDA installation | Less installer code, more support burden | Smaller managed footprint; inconsistent user environments | Setup failures and dependency conflicts become user problems | Retain as advanced option |
| Replace WhisperX with whisper.cpp CUDA/Vulkan | Native packaging can be smaller; another backend to validate | Smaller recognition runtime; separate GGML models | Broad GPU potential, but would change the timing workflow the user migrated away from | Keep fallback; consider Vulkan separately later |
| Faster-whisper plus an ONNX alignment implementation | Custom conversion, alignment integration, and model compatibility work | Potentially removes much of the PyTorch dependency cost | Promising space savings, but timing parity and model support require a separate evaluation | Reconsider only if measured runtime size becomes unacceptable |
| Cloud speech service | Service-specific API and billing behavior | Minimal local speech dependencies | Uploads audio, needs connectivity, changes the local-first workflow | Separate optional product feature, outside this GPU work |

WhisperX already uses faster-whisper/CTranslate2 for recognition; switching only the recognition wrapper does not remove PyTorch alignment. WhisperX 3.8.6 declares pyannote, torchvision, and other packages as dependencies even when this app uses Silero and does not enable diarization. Removing them blindly would create an unsupported installation or require maintaining a fork.

## Runtime installation and storage

### Reproducible profiles

Define two Windows x64 profiles, `cpu` and `cuda`, from one dependency source. Generate complete version locks with wheel hashes and explicit package sources. Normal installation must consume the lock, rather than resolve whatever happens to be newest that day. Use the same profile definitions for developer setup, one-click setup, repair, and CI.

Start the compatibility evaluation with the current WhisperX 3.8.6 and PyTorch 2.8 family. Upstream 3.8.6 selects CUDA 12.8 wheels on x64; that is a candidate to test, not a promise that every required DLL is already covered. Pin the final Python, WhisperX, faster-whisper, CTranslate2, PyTorch, torchaudio, torchvision, Transformers, and CUDA library combination only after actual Windows inference passes.

Install required runtime libraries, not a compiler/toolkit by default. First test whether the selected PyTorch distribution's compatible cuBLAS/cuDNN libraries can also satisfy CTranslate2. Download additional redistributables only when needed. Record their hashes and redistribution notices. Set DLL search paths for the child process only; do not modify system Python, registry, or global PATH.

The NVIDIA driver remains a system prerequisite. Detect and explain an incompatible driver; the app should not install drivers automatically. Device detection must work without a CUDA toolkit or managed Python already present. `nvidia-smi` is useful when available, but its absence is not proof that no supported GPU exists.

### One active installation

CPU-only users get the CPU profile. GPU users get a CUDA profile verified on both GPU and CPU. Switching the device to CPU should not require installing another complete environment.

Installation sequence:

1. Check hardware compatibility and free disk on the actual installation volume, including staged installation and temporary download costs.
2. Download verified installer and locked dependencies into an owned staging environment.
3. Perform runtime import checks, a small CUDA operation, and recognition/alignment verification.
4. Atomically activate a manifest referring to the immutable environment.
5. Retain at most one previous installation through the first successful real speech job and restart; then reclaim it when no job references it. Offer rollback/repair before reclamation and an explicit option to retain a backup.

Cancellation or failure preserves the previous active installation. Installation and cleanup must not remove or mutate environments used by running jobs. On restart, remove abandoned staging directories only after validating ownership and manifest references.

Use a logical managed runtime ID in settings, resolving its executable through the active manifest. Keep a custom Python executable as a separate advanced configuration. Migrate existing settings without taking ownership of, rewriting, or deleting external Python installations. This also avoids a crash leaving the active marker and saved executable path inconsistent.

### Bound storage growth

- Store private Python and runtimes outside the repository and app release directory.
- Share a model/cache location across CPU/CUDA profiles; changing devices must not download the same compatible model again.
- Treat WhisperX/CTranslate2 and whisper.cpp/GGML models as different formats; do not claim they can share one model file.
- Use uv hardlinks on supported same-volume Windows filesystems, with copy fallback. Keep managed package files immutable. Use uv's cache commands rather than manually modifying its internals.
- Keep a bounded installer cache for retries, then reclaim expendable downloads. Distinguish logical sizes from actual disk savings when hardlinks are involved.
- Show installed runtime, models, temporary audio, and old-version sizes separately in Settings. Provide bounded cleanup and uninstall controls. Model deletion is explicit; no silent deletion of downloaded models or project speech archives.
- Investigate removing a version-specific list of developer-only build artifacts after installation. The locally measured `.lib` files are a candidate. Do not remove runtime DLLs, required Python modules, model weights, or license notices. This is optional and must pass inference, offline, repair, and upgrade tests before shipping.

Exact GPU download size, installed size, and peak installation space remain unknown until the compatibility prototype is measured. Report these separately, with and without models. The editor ZIP should grow only by small installer/protocol changes.

## Code boundaries

Keep the implementation small and specific:

- **Renderer:** settings, device choice, detected capabilities, storage summary, and task feedback. No package installation or GPU decisions in React.
- **Shared contracts:** validated runtime profile, device preference, capability result, structured worker events, and execution metadata. Add `auto` to the existing CPU/CUDA choice with backward-compatible defaults.
- **Runtime manager/installer:** manifest resolution, profile locks, staged installation, verification, repair, ownership, and cleanup. Separate policy from download/process execution so existing installer race tests remain useful.
- **Speech orchestration:** choose an execution plan, snapshot inputs, acquire a resource slot/runtime reference, prepare audio, run/retry stages, and import completed output using existing edit-conflict guards.
- **Python worker:** upstream WhisperX calls, real capability checks, stage checkpoints, structured failures, and execution metadata. Leave caption editing, translation, project persistence, and padding policy in their existing TypeScript layers.

Do not turn this into a general plugin framework or move inference into Electron. Reuse `Jobs` and the argument-array subprocess launcher. Refactor only the speech/settings sections of the large main and renderer files touched by this feature.

## Device and execution policy

Provide **Auto / CPU / NVIDIA GPU**. Auto chooses GPU only when the installed runtime and selected device pass capability checks. Explicit GPU selection reports a failure rather than pretending the job ran on GPU. In Auto mode, CPU fallback is allowed and must be visible in progress and saved execution metadata.

Keep the selected ASR model independent of device and speed controls. Preserve the existing medium default initially; offer larger models through the existing model setting once validated. Do not call medium universally best or choose a smaller model to conceal a memory failure.

GPU recognition starts with FP16 where supported. Select a conservative batch from the model, available VRAM, and measured profiles. For the 6 GiB test machine, evaluate medium at batch one and two first. Total VRAM alone is insufficient because playback and other applications also use it. Higher batch sizes are a throughput setting, not an accuracy improvement.

An optional low-memory `int8_float16` mode can be added after quality evaluation. It must be explicit; quantization can change results, and changing computation at runtime does not by itself shrink the stored model.

Recognition and alignment have separate effective device fields, even if the UI starts with one preference. Unload recognition before alignment as today. Account for both CTranslate2 and PyTorch allocations: `torch.cuda.empty_cache()` does not free memory owned by CTranslate2. Releasing model objects or restarting the worker is necessary when recovery requires a clean GPU state.

Use bounded CPU thread settings so CPU fallback and preprocessing leave room for the editor. Keep model/capability recommendations separate from project data. Save actual model revision, runtime version, device index/name, precision, batch, and fallback reason with each speech run.

## Jobs, failures, and recovery

Run one speech inference/alignment job at a time initially, enforced in the main process. Queued jobs are cancellable. Downloads and network translation can continue independently; CPU-heavy conversion/waveform work should be scheduled so it does not overwhelm speech or playback. Replace broad UI blocking only where independent operations already have safe project/request guards.

Use one fresh Python process per job initially. This provides predictable cancellation and memory release. A permanently resident service can reduce repeated model loading, but adds idle memory, request isolation, and recovery complexity. Consider a short-lived warm worker only if profiling shows startup/model loading dominates common re-alignment use.

Add protocol-versioned events and structured failure codes: CUDA unavailable, unsupported precision, GPU out of memory, missing library, missing offline model, and invalid input. Do not classify every nonzero exit as an out-of-memory error or retry arbitrary failures.

For GPU memory failures:

1. Retry recognition at a smaller batch in a fresh worker, bounded down to one. Keep the selected model and precision.
2. If it still cannot fit, Auto may continue on CPU with a visible explanation; explicit GPU offers a CPU retry. Never silently reduce the model or switch to whisper.cpp.
3. If recognition succeeds and alignment fails, reuse the preserved recognition result and retry alignment on CPU. Avoid transcribing again.

Write the full recognition output atomically before starting alignment. Record completed alignment outputs as checkpoints when useful for long jobs. Tie recovery to media fingerprint, project/request ID, input snapshot, model/runtime/options, and corrected captions. Never reuse a checkpoint against changed input. Keep all returned fields and only normalize JSON-incompatible values as the current worker does.

The minimum feature is automatic stage recovery within the same job. Cross-session resume can follow if justified by long-recording tests. Cancellation keeps already committed editor data intact, releases the resource slot, and cleans temporary files; retries cannot overwrite edits made while work was running.

## Whole-project performance and space

GPU acceleration primarily benefits recognition and forced alignment. Remote API translation runs at the provider and will not accelerate because a local CUDA runtime is installed. Waveform generation is CPU audio decoding/reduction; video preview uses Chromium's existing media path. GPU-encoding FFmpeg playback copies is a separate feature with separate compatibility/quality testing.

Preserve the saved waveform and avoid reanalyzing it. Do not add a second persistent PCM cache by default: 16 kHz mono PCM16 audio costs approximately **115.2 MB per hour**, excluding container overhead, and the float32 worker array alone costs approximately **230.4 MB per hour** before temporary copies and model allocations.

First reuse the same prepared WAV within a speech job and all its retries. If repeated re-alignment proves expensive, add an optional bounded audio cache keyed by media fingerprint, stream choice, and conversion format. Memory-map or reduce unnecessary full-audio copies if long-file tests show RAM pressure. Do not cut recordings into arbitrary chunks that change WhisperX's segmentation/context just to obtain smaller buffers.

Full speech archives are a separate project-size cost. Retain them as requested. Measure long-project save/autosave and renderer memory before proposing compression or moving archives to a project container. Hardware support must not force a project-format migration or discard raw results.

## Settings and user workflow

Settings should show detected GPU and memory, installed runtime profile/version, device preference, and **Install GPU support / Repair / Check setup** actions. Existing CPU installation remains available. Advanced settings hold custom Python, device index, batch limit, and low-memory precision; avoid making ordinary users choose CUDA toolkit versions.

Show runtime installation progress in the task panel. Before downloading, display measured download and installed-space estimates. Explain that transcription and alignment models download separately, show their first-use download state, and preserve cached-model-only mode.

Separate **runtime ready** from **selected model ready**. A CUDA tensor allocation is not enough. Validate recognition and alignment with a short speech fixture and cached/downloaded validation models, recording any additional model download explicitly. Validate the user's selected model when first used; do not quietly download every model during setup. The task panel must show the device actually used and any fallback.

## Validation and release gates

Automated policy tests may simulate device capabilities and failures, but must be described as simulations. They do not prove GPU operation.

CPU CI verifies locked installation, migration, cancellation/activation races, queueing, checkpoint invalidation, fallback bounds, archive preservation, and existing caption/project/export behavior. Include a packaged smoke test and real CPU speech integration. Keep tests isolated from the user's settings, models, and active runtime.

GPU validation requires actual hardware. Initially use the RTX 3060 laptop; add at least a second NVIDIA configuration before broad compatibility claims. Document which GPU/driver/runtime combinations were tested. Cover GPU recognition and alignment, CPU jobs using the CUDA runtime, cold/warm starts, long audio and video, playback during work, re-alignment, offline operation, missing libraries, installation cancellation/failure, and shutdown. Use controlled allocation limits or real contention to exercise memory recovery, in addition to unit simulations.

Benchmark medium and large-v3 where feasible, with identical decoding options and model revisions. Measure recognition, alignment, conversion, cold startup, total wall time, peak VRAM, peak RAM, download bytes, installed bytes, and peak install disk. Use real transcribed fixtures and reviewed reference text/timing; report WER and word-boundary error summaries rather than only checking that a JSON file exists. CPU INT8 and GPU FP16 outputs need not match byte-for-byte. Establish quality/timing acceptance thresholds from the reviewed corpus before selecting a default batch/precision profile.

Release only when:

- Clean installation works without a separately installed Python or full CUDA toolkit on tested Windows systems; document driver and any remaining runtime prerequisite precisely.
- GPU recognition and alignment both execute successfully, and CPU mode works in the same CUDA runtime.
- Cancellation returns the app to a usable state and releases GPU resources.
- Failure/retry does not lose raw outputs, overwrite current edits, or change models silently.
- Existing 50 ms padding, sentence imports, stable IDs, translation invalidation, waveform reuse, save/reopen, and SRT/TXT export remain correct.
- Storage is measured and bounded, upgrades retain rollback safely, and cleanup cannot touch projects or external environments.
- Installer repair works and the distributed app remains keyboard-friendly and responsive.

## Implementation sequence

1. **Compatibility and size prototype:** verify both backends with the candidate lock on Windows; test CPU in the CUDA environment, library sharing, drivers, model choices, and actual disk/VRAM use. Decide whether private runtime-library installation is viable before promising one-click support.
2. **Shared runtime profiles:** complete locks, unify manual/developer/managed setup, migrate logical runtime selection, extend transactional activation and ownership tests, add bounded cleanup.
3. **Speech execution policy:** typed capabilities/errors, main-process resource control, dynamic batch limits, stage checkpoints, bounded GPU recovery, and execution provenance.
4. **Settings integration:** one-click CUDA installation, actual readiness checks, visible fallback, storage management, and offline/model status.
5. **Real validation:** hardware benchmarks, quality/timing corpus, long-file tests, packaged verification, and precisely documented prerequisites. Publish only when requested.
6. **Measured follow-ups:** inference-only build-artifact trimming, bounded audio reuse, warm workers, or additional GPU backends. Each must justify its added complexity with actual savings.

## Sources

- [WhisperX 3.8.6 dependency and package-source definitions](https://github.com/m-bain/whisperX/blob/v3.8.6/pyproject.toml): current baseline constraints and CUDA wheel source.
- [WhisperX 3.8.6 recognition implementation](https://github.com/m-bain/whisperX/blob/v3.8.6/whisperx/asr.py): faster-whisper/CTranslate2 recognition and PyTorch pipeline integration.
- [WhisperX 3.8.6 alignment implementation](https://github.com/m-bain/whisperX/blob/v3.8.6/whisperx/alignment.py): existing alignment behavior to preserve.
- [faster-whisper GPU requirements and benchmarks](https://github.com/SYSTRAN/faster-whisper#gpu): CUDA/cuBLAS/cuDNN requirements; upstream benchmarks are not app performance promises.
- [CTranslate2 computation and quantization](https://opennmt.net/CTranslate2/quantization.html): supported compute types and distinction between stored and execution precision.
- [uv locking and synchronization](https://docs.astral.sh/uv/pip/compile/): exact dependency reproduction.
- [uv link-mode settings](https://docs.astral.sh/uv/reference/settings/#link-mode): Windows hardlink installation and copy fallback design.
- [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html): driver/runtime compatibility must match the chosen release.
- [whisper.cpp GPU backends](https://github.com/ggml-org/whisper.cpp#vulkan-gpu-support): possible later native CUDA/Vulkan alternative.

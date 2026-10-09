# WhisperX setup

WhisperX is the default speech engine. The existing whisper.cpp engine remains selectable as a legacy fallback. Existing projects, caption IDs, translations and review states are preserved.

## One-click Windows CPU or NVIDIA setup

In the local source/unpackaged build, open **Settings → Install WhisperX** for CPU, or **Install GPU support** for NVIDIA CUDA. This downloads a checksum-verified uv installer, private Python 3.12.14, and fully hash-locked dependencies: WhisperX 3.8.6, PyTorch/torchaudio 2.8.0, torchvision 0.23.0, Transformers 4.57.6, CTranslate2 4.8.2 and faster-whisper 1.2.1. The GPU profile includes CUDA 12.8 and cuDNN libraries and also supports CPU operation. It does not change system Python, PATH or registry configuration. No system Python or full CUDA toolkit is needed.

Progress and cancellation appear in the task panel. Once verification succeeds, the brief final activation phase disables Cancel so a completed activation cannot be reported as cancelled. Closing the app waits for activation or cancelled-job cleanup before exiting. Repeated clicks do not start a second simultaneous installation. Failed/cancelled installations remove their incomplete environment and retain the previous active runtime. Reinstall creates and verifies a new environment before selecting it; previous successful environments remain available on disk.

Internet access and at least **6 GiB free for CPU or 12 GiB for GPU** are required during installation, plus model space. Downloads are approximately 0.8 GiB for CPU or 3.5 GiB for GPU. Link-time PyTorch build libraries are removed only from managed, version-checked installations; inference DLLs remain. The default location is the app's user-data folder under `runtime/whisperx`. **Advanced performance settings → Choose runtime folder** lets you select another drive before installing. Changing the folder does not move an existing installation. Models use the separate cache configured in Settings and download on first use. No administrator access or API key is required.

These GPU changes are available from source and have not been released. Published builds may offer only the earlier CPU installer.

## Manual or GPU environment

Install 64-bit Python **3.12**, then run from the project directory:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-whisperx.ps1
# NVIDIA profile:
powershell -ExecutionPolicy Bypass -File scripts/setup-whisperx.ps1 -Profile cuda
```

The script creates `.tools/whisperx` using the same complete dependency locks. Keep `scripts/speech-runtime` alongside it. To select Python, pass `-Python 'C:\path\to\python.exe'`. In Settings, enable **Use a custom Python environment**, point **WhisperX Python executable** to `.tools\whisperx\Scripts\python.exe`, select a device, and click **Check WhisperX setup**. Models are downloaded separately.

The model field accepts a faster-whisper model ID (for example `medium`, `large-v3`, `tiny.en`) or a local CTranslate2 model directory. GGML `.bin` files from whisper.cpp are not compatible. Use a multilingual model for Chinese. The default model is `medium`; smaller models trade recognition quality for lower CPU and memory requirements.

## Downloads and offline use

First use downloads the selected transcription model, Silero speech detection, sentence data, and a language-specific forced-alignment model into the configured cache. English uses `facebook/wav2vec2-base-960h`; Mandarin Chinese uses `jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn`. Chinese alignment units are characters. These downloads require internet access and can be large. Transcription, alignment and audio remain local.

Once the required models have been used, enable **Use cached models only**. Missing cache data produces an error instead of silently downloading. A Python setup check confirms the runtime imports and selected device; it does not download or validate every model. Speaker diarization is not enabled and no Hugging Face token is required for the chosen public models.

## GPU setup

NVIDIA acceleration requires a CUDA-12.8-compatible NVIDIA driver and sufficient VRAM. The managed GPU installer supplies the matching Python libraries. Settings shows detected GPU, VRAM and driver. Validation used an RTX 3060 Laptop GPU with 6 GiB VRAM and driver 581.80; other hardware has not been tested locally. CPU mode needs no NVIDIA hardware.

**Auto** selects CUDA when available. Recognition uses FP16 by default and a conservative batch based on available VRAM. Memory failures reduce the batch first; Auto can retry on CPU without changing the selected model. Explicit **NVIDIA GPU** reports failures instead of switching to CPU. INT8/FP16 is optional because outputs may differ. Recognition checkpoints and incremental alignment checkpoints let retries reuse completed work. Completed and failed/cancelled partial outputs are retained in project speech archives. Progress records device, precision, batch and fallback reasons.

Speech jobs and runtime maintenance share a cancellable queue; editing and unrelated tasks remain responsive. Each job runs a fresh worker, releasing GPU memory on completion or cancellation. Installation verifies module imports and real CUDA operations; first successful model inference marks the runtime verified. **Remove previous speech runtimes** then removes only obsolete managed environments, preserving the active runtime, custom environments and model cache.

## Editing workflow

**Transcribe** prepares audio, recognizes speech, and aligns it before importing captions. The importer uses each returned aligned sentence as one block, preserving its exact text. It does not cut at length, duration or pause thresholds. Long blocks remain available for manual splitting. Progress and cancellation remain in the task panel. Missing or low-confidence alignment is marked **Check sync**; missing word times are not fabricated.

After correcting source text, select captions and click **Re-align selection**, or use **Re-align all**. Re-alignment uses the existing approximate time window with 0.5 seconds of context on each side. Large timing mistakes need a rough manual adjustment first. Results never overwrite source/timing edits made during the job. Target edits and review state are preserved. Source text changes still invalidate translation normally.

The timeline has one row of blocks: source text initially, translated text once available. Source and translation remain side by side in the editor and export as separate SRT files.

## Reproducible integration test

With the assets from README and the Python environment installed:

```powershell
$env:TEST_WHISPERX='1'
npm run build
npm run test:pipeline
```

The test uses `tiny.en`, real speech and forced alignment, re-alignment, then a mock translation endpoint. Warm the model cache before running if first-time downloads exceed the test timeout. This verifies integration, not translation quality or timing accuracy on all recordings.

## Result preservation and padding

Projects embed `speechRuns`: full returned transcription results, full per-input alignment results (including word/character details and additional fields), model/device/version metadata, and immutable imported caption snapshots. Re-alignment stores a separate run with its corrected source input. JSON-incompatible NaN/infinity values are retained as null. No new Chinese sentence detection is applied.

Aligned sentence times receive 50 ms padding at each end, clipped to media boundaries. Adjacent non-overlapping sentences share short gaps so padding cannot introduce overlap. Actual overlapping speech remains unchanged and is flagged by the editor. Missing word times stay missing; unavailable sentence times use an explicitly flagged approximate input window for review. Unusable results are retained with an import error and do not replace existing captions.

When captions exist, choose **Replace captions** or **Add captions** before transcription. Both changes support Undo/Redo. If captions change during replacement, results are archived but current edits are preserved. Raw archives increase project size and remain out of SRT exports. Previously saved projects cannot recover raw results that were discarded by earlier app versions; transcribe again to create the new archives.

## Installer verification

`npm run test:install` runs an opt-in network test that performs an actual installation in an isolated ignored test profile, checks duplicate prevention and automatic selection, and reopens the app to verify persistence. Build the app first. After a successful installation test, set `TEST_INSTALL_REUSE=1` to repeat just the runtime-selection and Settings/reopen checks without downloading again. Unit tests cover failed verification, cancellation during dependency installation, preservation of the previous runtime, and invalid manifest paths.

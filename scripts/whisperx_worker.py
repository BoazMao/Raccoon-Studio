"""Raccoon Studio's local worker. stdout protocol: STUDIO:<JSON>, one line/event."""
import gc
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import wave
import time

STAGE = "runtime"
DEVICE = "cpu"


def event(value):
    print("STUDIO:" + json.dumps(value, ensure_ascii=False), flush=True)


def json_safe(value):
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, (float, int)):
        return value if math.isfinite(value) else None
    if hasattr(value, "item"):
        return json_safe(value.item())
    return value


def atomic_json(file, value):
    file = Path(file)
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(json_safe(value), ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(file)


class SpeechError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def progress(percent, message):
    print("STUDIO:" + json.dumps({"progress": percent, "message": message}), flush=True)


def finite(value):
    return float(value) if value is not None and math.isfinite(float(value)) else None


def main():
    global STAGE, DEVICE
    started = time.perf_counter()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    DEVICE = "cuda" if request["device"] in ("auto", "cuda") else "cpu"
    if request.get("protocol", 1) not in (1, 2):
        raise RuntimeError("Unsupported speech worker protocol")
    cache = Path(request["cache"])
    cache.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache / "huggingface")
    os.environ["NLTK_DATA"] = str(cache / "nltk")
    if request.get("offline"):
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    progress(16, "Loading WhisperX runtime")
    # CTranslate2 and PyTorch use the same verified CUDA libraries. Scope lookup to
    # this worker, keeping system PATH and other Python environments unchanged.
    dll_handles = []
    spec = importlib.util.find_spec("torch")
    if os.name == "nt" and spec and spec.origin:
        dlls = Path(spec.origin).parent / "lib"
        dll_handles.append(os.add_dll_directory(str(dlls)))
        os.environ["PATH"] = str(dlls) + os.pathsep + os.environ.get("PATH", "")
    import numpy as np
    import torch
    import whisperx
    import nltk
    import ctranslate2
    torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) - 1)))
    torch.hub.set_dir(str(cache / "torch"))
    nltk.data.path.insert(0, str(cache / "nltk"))
    preference = request["device"]
    device = "cuda" if preference == "auto" and torch.cuda.is_available() else "cpu" if preference == "auto" else preference
    DEVICE = device
    if preference == "auto" and device == "cpu":
        progress(17, "Using CPU: CUDA is not available in this runtime")
    if device == "cuda" and not torch.cuda.is_available():
        raise SpeechError("cuda_unavailable", "CUDA is not available in this Python environment. Select Auto/CPU or install GPU support in Settings.")
    compute_type = request.get("precision", "float16") if device == "cuda" else "int8"
    if device == "cuda":
        if compute_type not in ctranslate2.get_supported_compute_types("cuda"):
            raise SpeechError("unsupported_precision", f"This GPU does not support {compute_type}. Select CPU.")
        available, total = torch.cuda.mem_get_info()
        batch = 1 if available < 3 * 1024**3 else 2 if available < 7 * 1024**3 else 4
        # Larger models need more headroom; retries can only lower this cap.
        if "large" in request["model"] or "turbo" in request["model"]:
            batch = min(batch, 2)
        if request.get("batchLimit", 0):
            batch = min(batch, request["batchLimit"])
    else:
        batch = 1
    execution = {"requestedDevice": request.get("requestedDevice", preference), "device": device, "precision": compute_type, "batch": batch,
        "fallbackReason": "CUDA unavailable" if preference == "auto" and device == "cpu" else None,
        "gpu": torch.cuda.get_device_name() if device == "cuda" else None,
        "runtime": {name: importlib.metadata.version(name) for name in ["whisperx", "torch", "ctranslate2", "faster-whisper"]}}
    event({"type": "execution", **execution})
    if request.get("check"):
        # Import the actual inference modules too, to catch incompatible dependencies.
        from whisperx.asr import load_model
        from whisperx.alignment import load_align_model
        if device == "cuda":
            import ctypes
            ctypes.WinDLL("cublas64_12.dll")
            ctypes.WinDLL("cudnn64_9.dll")
            torch.nn.functional.conv1d(torch.ones((1, 1, 16), device="cuda"), torch.ones((1, 1, 3), device="cuda"))
            torch.cuda.synchronize()
        progress(100, f"WhisperX {importlib.metadata.version('whisperx')} runtime checked on {device}. Selected models are verified during transcription.")
        return
    try:
        nltk.data.find("tokenizers/punkt_tab/english/")
    except LookupError:
        if request.get("offline"):
            raise RuntimeError("Offline cache lacks NLTK punkt_tab. Run once with offline mode disabled.")
        progress(18, "Downloading sentence data for alignment")
        if not nltk.download("punkt_tab", download_dir=str(cache / "nltk"), quiet=True):
            raise RuntimeError("Could not download NLTK sentence data")
    with wave.open(request["audio"], "rb") as wav:
        if (wav.getnchannels(), wav.getframerate(), wav.getsampwidth()) != (1, 16000, 2):
            raise RuntimeError("Expected 16 kHz mono PCM audio")
        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    originals = request.get("captions")
    checkpoint = Path(request.get("checkpoint", str(Path(request["output"]).with_name("recognition.json"))))
    alignment_checkpoint = checkpoint.with_name("alignment-checkpoint.jsonl")
    recognition_execution = execution
    recognition_seconds = 0
    if originals is None:
        # WhisperX loads Silero via torch.hub. Resolve cached code locally so offline mode never probes GitHub.
        hub_load = torch.hub.load
        def cached_hub_load(repo_or_dir, *args, **kwargs):
            if repo_or_dir == "snakers4/silero-vad":
                cached = next((p for p in (cache / "torch").glob("snakers4_silero-vad_*") if (p / "hubconf.py").exists()), None)
                if cached:
                    kwargs.pop("trust_repo", None)
                    kwargs.pop("force_reload", None)
                    return hub_load(str(cached), *args, source="local", **kwargs)
                if request.get("offline"):
                    raise RuntimeError("Offline cache lacks Silero VAD. Transcribe once with offline mode disabled.")
            return hub_load(repo_or_dir, *args, **kwargs)
        torch.hub.load = cached_hub_load
        STAGE = "recognition"
        if request.get("resume") and checkpoint.exists():
            saved = json.loads(checkpoint.read_text(encoding="utf-8"))
            result = saved["transcription"]
            recognition_execution = saved["execution"]
            recognition_seconds = saved["seconds"]
            progress(60, "Reusing completed transcription for alignment retry")
        else:
            recognition_started = time.perf_counter()
            progress(20, "Loading transcription model (first use may download)")
            model = whisperx.load_model(request["model"], device, compute_type=compute_type,
                language=request["language"], vad_method="silero", download_root=str(cache / "asr"),
                local_files_only=request.get("offline", False))
            progress(30, f"Transcribing on {device.upper()} · batch {batch} · {compute_type}")
            result = model.transcribe(audio, batch_size=batch, language=request["language"], progress_callback=lambda n: progress(30 + n * 0.3, f"Transcribing on {device.upper()} · batch {batch}"))
            recognition_seconds = time.perf_counter() - recognition_started
            atomic_json(checkpoint, {"transcription": result, "execution": execution, "seconds": recognition_seconds})
            del model
            gc.collect()
            if device == "cuda":
                torch.cuda.empty_cache()
        transcription = result
        segments = result["segments"]
    else:
        transcription = None
        segments = [{"start": max(0, c["start"] - 0.5), "end": min(len(audio)/16000, c["end"] + 0.5), "text": c["source"], "id": c["id"]} for c in originals]
    STAGE = "alignment"
    alignment_started = time.perf_counter()
    alignment_device = "cpu" if request.get("alignmentCpu") else device
    DEVICE = alignment_device
    if segments:
        progress(65, "Loading forced-alignment model (first use may download)")
        # HF models support local_files_only consistently; English and Mandarin caches stay separate.
        align_name = "facebook/wav2vec2-base-960h" if request["language"] == "en" else "jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn"
        align_model, metadata = whisperx.load_align_model(request["language"], alignment_device,
            model_name=align_name, model_dir=str(cache / "alignment"), model_cache_only=request.get("offline", False))
    aligned = []
    raw_alignments = []
    if request.get("resume") and alignment_checkpoint.exists():
        for line in alignment_checkpoint.read_text(encoding="utf-8").splitlines():
            try:
                raw_alignments.append(json.loads(line))
            except json.JSONDecodeError:
                break  # A killed worker may leave a partial final record.
        # Remove a partial tail before appending more completed results.
        alignment_checkpoint.write_text(''.join(json.dumps(value, ensure_ascii=False) + '\n' for value in raw_alignments), encoding="utf-8")
    elif alignment_checkpoint.exists():
        alignment_checkpoint.unlink()
    for index, segment in enumerate(segments):
        if index < len(raw_alignments):
            result = raw_alignments[index]["output"]
        else:
            result = whisperx.align([segment], align_model, metadata, audio, alignment_device,
                interpolate_method="ignore", return_char_alignments=True)
            raw_alignments.append({"input": segment, "output": result, "device": alignment_device})
            with alignment_checkpoint.open("a", encoding="utf-8") as checkpoint_file:
                checkpoint_file.write(json.dumps(json_safe(raw_alignments[-1]), ensure_ascii=False, allow_nan=False) + '\n')
        # Re-alignment preserves the user's existing block; fresh transcription
        # imports each returned sentence independently, without regrouping words.
        returned = result["segments"]
        if originals is not None:
            returned = [{"text": segment["text"],
                "start": min((s["start"] for s in returned if finite(s.get("start")) is not None), default=None),
                "end": max((s["end"] for s in returned if finite(s.get("end")) is not None), default=None),
                "words": [w for s in returned for w in s.get("words", [])]}]
        if not returned:
            returned = [{"text": segment["text"], "start": None, "end": None, "words": []}]
        for sentence in returned:
            aligned.append({"id": segment.get("id"), "start": finite(sentence.get("start")),
                "end": finite(sentence.get("end")), "text": sentence["text"],
                "window": {"start": segment["start"], "end": segment["end"]},
                "units": [{"text": w["word"], "start": finite(w.get("start")), "end": finite(w.get("end")),
                    "confidence": finite(w.get("score"))} for w in sentence.get("words", [])]})
        progress(65 + 32 * (index + 1) / max(1, len(segments)), f"Aligning on {alignment_device.upper()} {index + 1}/{len(segments)}")
    payload = {"version": 2, "language": request["language"], "segments": aligned,
        "raw": {"transcription": transcription, "alignments": raw_alignments,
            "model": request["model"], "device": recognition_execution["device"], "whisperxVersion": importlib.metadata.version("whisperx"),
            "execution": {"recognition": recognition_execution, "alignmentDevice": alignment_device,
                "recognitionSeconds": recognition_seconds, "alignmentSeconds": time.perf_counter() - alignment_started,
                "workerSeconds": time.perf_counter() - started, "fallbacks": request.get("fallbacks", [])},
            "correctedCaptions": originals}}
    atomic_json(request["output"], payload)
    progress(99, "Alignment complete")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error)
        lowered = message.lower()
        code = getattr(error, "code", "runtime_error")
        if DEVICE == "cuda":
            if "out of memory" in lowered or "cuda_error_out_of_memory" in lowered:
                code = "gpu_memory"
            elif any(x in lowered for x in ["cublas", "cudnn", "dll load failed", "winerror 126"]):
                code = "missing_library"
            elif any(x in lowered for x in ["driver version is insufficient", "no cuda-capable device", "cuda initialization"]):
                code = "cuda_unavailable"
        event({"type": "failure", "code": code, "stage": STAGE, "message": message})
        print(f"WhisperX: {error}", file=sys.stderr, flush=True)
        sys.exit(1)

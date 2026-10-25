# Performance and quality checks

The speed improvements keep the current default WhisperX `medium` model, FP16 GPU/INT8 CPU execution, upstream sentence output, full raw archives, 50 ms padding, and default-on translation meaning checks.

- Production builds use production React. The caption list mounts visible rows and a small overscan; selection, clipboard and undo operate on the entire project. Very dense, zoomed-out timeline regions display caption groups; click a group to zoom into individual blocks. Selected blocks remain individually accessible.
- Project validation and JSON parsing/serialization run in a background worker. Recovery files share one compact serialized snapshot. Obsolete pending autosaves coalesce; explicit saves retain their order and atomic replacement. Existing `.captionproj` files remain readable.
- Speech requests reuse one interpreter for up to 90 seconds idle. Imports remain warm; recognition and alignment models are released after each request. Cancellation/failure destroys the interpreter before another attempt. Changing Python, model-cache location or offline mode starts a new interpreter. Settings → Advanced performance settings can disable reuse or release speech memory immediately. Runtime installation/cleanup also releases it first so Windows DLL locks do not prevent maintenance.
- Saved speech-run execution data includes import, recognition-load/inference and alignment-load/inference timings. Cold and warm timing must be compared separately. Stage times do not include Electron IPC, FFmpeg preparation or every cleanup cost; total job wall time matters too.
- `Check wording` uses a low ASR average-log-probability warning, separately from alignment confidence and `Check sync`. The current conservative threshold is -1; it is a review heuristic, not calibrated accuracy or a percentage. Correcting source text clears its original recognition warning and marks alignment for rechecking. Use **✓ Wording** to acknowledge a checked source without changing it; its score remains. Raw scores remain in the archived output.
- Translation verification is saved separately from draft text. Default retries can retry a failed meaning check without generating its unchanged draft again. Source/neighborhood/guidance/model/endpoint changes invalidate reuse; manual edits and reviewed translations remain protected. Sparse batches retain intervening captions as context-only text. Requests remain sequential by default.
- Video frame stepping uses nearby actual FFprobe presentation timestamps, including VFR media, with a visible nominal-step fallback if indexing is unavailable. Playing video subtitles follow presented video frames. Export readiness is available in the caption footer; SRT export removes internal blank separators while preserving original project text.

## Run the checks

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:performance
npm run test:translation
npm run test:download
```

`test:performance` generates its own audio fixture, uses a clearly controlled speech-result event to test archive/undo handling, and edits/copies 3,000 captions through the real Electron UI. It is not an ASR quality test. Unit tests also generate a real variable-frame-rate video to check presentation-time stepping. CI runs the checks that need no speech models or API key on Windows PRs.

To run the same workflows against the unpackaged executable, build it using the README instructions and set `$env:TEST_PACKAGED='1'`. `test:audio` and `test:gpu` need the cached test assets described in VERIFICATION.md. No speech runtime/model is bundled into the editor by these changes.

## Evaluate a reviewed reference set

Create a JSON file containing short English reference clips and their saved result projects:

```json
[
  {
    "name": "names-and-negation",
    "project": "results/clip.captionproj",
    "reference": "Your independently checked transcript goes here.",
    "words": [
      {"text": "Your", "start": 0.2, "end": 0.5}
    ],
    "humanTranslationReview": {
      "omissions": 0,
      "additions": 0,
      "negationErrors": 0,
      "terminologyErrors": 0
    }
  }
]
```

The example word list is illustrative: supply a complete per-word reference corresponding to the transcript, or omit `words` until timing references are available. Human translation counts must come from actual bilingual review; omit them if not reviewed.

```powershell
npm run test:quality -- path/to/references.json
```

The tool reads saved raw recognition/alignment results and emits normalized word-error rate, matched timed-word count, median/p95 onset-and-offset error, and any supplied human translation review. It does not call an ASR engine or translation provider. It evaluates unpadded word times, not the intentional caption padding. Timing scores are null when compatible complete timing references are absent, and only words matched along the transcript edit path contribute. Always inspect timing coverage alongside errors. Keep clips below 4,000 words. Record human correction time separately.

A representative reference set is still required before claiming improved recognition/translation accuracy or changing model/decoder defaults. Include accents, names, numbers, negation, noise/music, long pauses, sentence edges crossing recognition chunks, and overlapping speakers. The current tests verify implementation correctness and preservation of results; they do not establish broad model quality.

Optional future work includes provider-aware parallel translation, a bounded prepared-audio cache, and model comparisons on that reference set. They are separate from the measured overhead reductions here.

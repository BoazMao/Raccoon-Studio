# Codebase review: speed and accuracy

> Historical baseline captured before implementation. The subsequent changes and remaining quality-evaluation requirements are documented in [Performance and quality checks](PERFORMANCE_AND_QUALITY.md) and the 24 October entry in [Verification](VERIFICATION.md). Source links below point to the reviewed commit, not the changed implementation.

Reviewed 24 October 2026 against GitHub `main` at `ce3e8dd206af16cbcc7161f05a88a8c3468b3148`. Local application, scripts, locks and tests match that tree; the local README lacks a later disclaimer. Application code was not changed for this review. Probes and an isolated production-renderer prototype are under `.tools/test-work/code-review/`, which is ignored by Git.

The priorities reflect the request to favor speed and accuracy. The highest-value work is removing UI/persistence overhead, avoiding repeated speech initialization, and measuring recognition/timing/translation quality on representative English-to-Chinese work. Existing process separation, stable caption IDs, source-edit invalidation, argument-array execution, GPU recovery policy, full-output preservation and human review should remain.

## Measured results

Type checking and all **54 existing tests passed** during this review. Passing these tests does not establish recognition or translation quality.

| Probe | Observation | Interpretation |
| --- | --- | --- |
| Existing renderer bundle | React and React DOM development modules are present; 1,487,393 bytes | The normal build ships development React. |
| Isolated production renderer | Same source, production define and minification: 339,346 bytes | A small build change removes development overhead without changing speech/translation settings. |
| 1,000 synthetic captions | Median input-to-two-animation-frames time: 372 ms current, 117 ms production | Production helps, but rendering all rows still exceeds a responsive editing target. |
| 3,000 synthetic captions | Median 903 ms current, 548 ms production; 42,163 DOM nodes and 3,000 timeline blocks | Virtualization and update isolation are needed beyond the build change. |
| Synthetic 5,000-caption project with one full word/character archive | First validation 308 ms, second validation 317 ms, pretty serialization 1,132 ms, read/parse/validation 1,273 ms | These synchronous operations currently run in Electron main and can stall IPC. Autosave repeats serialization for two recovery files. |
| Same synthetic project | Pretty JSON 96.1 MiB; compact JSON 35.1 MiB; deflated compact JSON 2.44 MiB | Whitespace and repeated raw structure are substantial. Compression must run off the main thread; this repetitive synthetic fixture compresses particularly well. |
| Warm real cached tiny.en CUDA worker, about 11 seconds of JFK speech | 15.55 seconds total; recognition inference 0.69 seconds; alignment inference 0.38 seconds | Most latency in this short case is startup, loading, initialization and cleanup, rather than neural inference. |
| Same real worker | Initial imports 2.23 seconds, recognition loading including lazy imports 8.59 seconds, alignment loading 0.42 seconds | Reusing a bounded worker/import state is a candidate for repeated work. The profile wrapper can affect object lifetime; this is stage attribution, not a new end-to-end app benchmark. |
| Sparse translation work | 100 eligible captions: 10 batches / 20 default requests when contiguous, versus 100 batches / 200 requests when alternating with reviewed captions | Reviewed gaps fragment the request workload even though the amount of text to translate is the same. No provider calls were made for this probe. |

Renderer measurements used the same interaction harness, four edits per scale and serial current/production comparison on this machine. Native dialogs were automated. Synthetic source edits were verified in the actual recovery files. These are diagnostic snapshots, not a broad hardware benchmark. An earlier concurrent run was slower; the table uses the later serial comparison. The isolated prototype was not applied to the normal build.

The real speech probe used the existing CUDA runtime and cached tiny.en/English alignment/Silero assets. It ran recognition and alignment; results were not injected. No medium/large model was downloaded, and no live translation API was called. The earlier medium GPU/CPU comparison in VERIFICATION.md is historical evidence, not a fresh test in this review. No representative accuracy corpus was available, so this review makes no measured WER or translation-quality claim.

## Recommended priorities

| Order | Change | Speed benefit | Accuracy benefit / constraint | Effort |
| --- | --- | --- | --- | --- |
| 1 | Build production React; isolate player/task updates; virtualize caption rows and visible timeline blocks | High, measured bottleneck | Preserve caption IDs, keyboard focus, selection, undo and timing behavior | Low for production build; medium for UI work |
| 2 | Move project parsing/serialization off main; serialize once; coalesce autosaves; narrow job/export IPC payloads | High on archive-heavy projects | Keep every raw result and atomic saves; prevent stale save acknowledgements | Medium |
| 3 | Preserve speech archives independently of caption undo and cancellation boundaries | Avoids expensive retranscription | Fixes reproduced loss of original results | Medium |
| 4 | Add quality and stage metrics, expose recognition uncertainty separately from alignment confidence | Makes tuning targeted | Establish actual transcript, timing and translation accuracy before changing model/decoder defaults | Medium; reviewed reference clips required |
| 5 | Reuse speech initialization and prepared audio where measured; maintain a bounded idle worker | High potential for short/repeated jobs | Same upstream models/options/segmentation; fresh process on cancellation or failure; release GPU models between stages | Medium/high |
| 6 | Separate translation drafting and meaning-check state; resume checks; improve sparse batching; evaluate concurrency two | Fewer duplicate requests and lower latency | Keep meaning checks, context, complete ID validation and protection of manual edits | Medium |
| 7 | Validate actual frame stepping and add export readiness checks | More efficient manual correction | Covers VFR media, stale targets, uncertain alignment and invalid cue text | Medium |

Package size and broad refactoring are secondary. Component extraction is justified where it limits rendering work, and storage changes where they remove save stalls or repeated processing.

## Findings and implementation direction

### 1. The packaged renderer contains development React

Evidence: [build script](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/scripts/build.mjs#L20). The renderer build has no production definition or minification. The resulting `dist/renderer.js` explicitly contains `react.development.js` and `react-dom-client.development.js`; packaging copies this bundle.

Add an explicit production build mode with `process.env.NODE_ENV` defined as `"production"`, retaining a distinct development mode for debugging. The isolated production probe reduced the bundle to about 23% of its current bytes and improved editing latency. Verify the distributed bundle and existing editor workflows after applying it. This changes application overhead without weakening recognition or translation quality.

### 2. UI work grows with the entire project on every playback/progress/edit update

Evidence: [derived caption data](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L176), [caption rendering](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L1435), [row numbering](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L1463), and [timeline blocks](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L1761).

The same component owns playback time, task progress, all caption inputs, selection and the timeline. Each update sorts captions, computes overlaps/readability, recreates the rows and renders every timeline block. `sorted.indexOf(c)` inside each row adds quadratic work. Array membership checks are also expensive during large selections, and group dragging repeatedly searches the original caption array.

Separate player/time, task panel, caption list and timeline update boundaries. Memoize order/index maps on relevant changes, use stable row props and selection sets, and virtualize visible caption rows and timeline blocks with overscan. Preserve focused text fields and keyboard navigation through off-screen captions. Capture a map of selected timing origins once at drag start and apply drag updates at most once per animation frame.

The first target should be edit-to-paint below 50 ms at 1,000 captions, then a measured larger-project target. Treat this as an acceptance target, not a promised speedup. The viewport waveform already limits canvas width; the measured full two-million-peak scan was about 4.6 ms. A waveform level-of-detail pyramid can follow if scrolling remains expensive after the larger UI costs are removed.

### 3. Autosave can block the main process despite asynchronous disk I/O

Evidence: [save handler](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/main.ts#L389), [project storage](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/storage.ts#L8), [autosave debounce](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L525), and [full-project IPC contracts](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/shared/ipc.ts#L103).

The renderer sends the entire project, including old speech archives, through IPC. Main validates it, then `writeProject` validates it again and synchronously stringifies it. Autosave writes both a per-project recovery file and a global recovery file, repeating validation/serialization. The pending map orders every save but does not replace obsolete queued autosaves. Opening a large project similarly parses and validates synchronously in main.

First preserve the JSON format: validate once at the boundary, move serialization/parsing into a worker, serialize one immutable revision once, and write the same bytes atomically to the required destinations. Keep explicit saves ordered; coalesce superseded autosaves. Attach project ID/revision to acknowledgements so an older save cannot mark newer edits saved or attach an old path to a newly opened project.

Then narrow transcription, alignment, translation and export requests to the fields each operation needs. Sending previous full archives and compressed waveforms to translate or export captions adds cloning/validation cost without improving those operations. Consider a lossless project container with immutable compressed archive entries only if real project measurements justify a format change; preserve existing JSON import and every original output. Existing undo snapshots share object references, so they should not be described as 100 independent deep copies of the raw archive.

### 4. Raw results can be lost through undo and late cancellation

**Confirmed result-preservation defect.** Evidence: [undo](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L216), [speech result commit](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L493), and [cancellation boundary](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/whisperx.ts#L192).

Reproduction in the actual UI with a clearly identified controlled speech-result event: import a result containing a raw archive, Undo, edit the restored source, then save. The archive is absent from the saved project and the new edit clears redo. This conflicts with retaining all WhisperX outputs. Store raw runs independently of undoable caption edits, as is already done for derived waveform data, or keep an append-only job-result store that project saves reference/embed.

A separate controlled worker-timing probe wrote both recognition and final result files, then cancelled at successful worker exit. The post-loop abort check threw a plain DOMException instead of SpeechJobError. Main's temporary-directory cleanup can then discard those files without archiving them. Cancellation and final-result commit need one consistent boundary that retains available outputs even when captions are not applied. Shutdown should also settle/capture speech results before destroying the renderer; current shutdown cancels jobs after the window has closed, when result events cannot be delivered. The shutdown case is a static finding, not a separately run hardware test.

### 5. Recognition confidence, alignment confidence and measured correctness are different

Evidence: [worker output projection](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/scripts/whisperx_worker.py#L222), [review flag calculation](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/shared/whisperx.ts#L101), and [alignment UI](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L1495).

The locked WhisperX runtime returns ASR `avg_logprob`, and full outputs retain it. Editable captions currently expose alignment token scores and a review flag based on timing completeness, low alignment scores and word overlap. A confidently aligned word can still be the wrong recognized word. `Audio aligned` is a timing indicator, not evidence that the transcript is correct.

Expose a distinct recognition-uncertainty signal linked back to the original ASR segment, while keeping alignment warnings separate. Calibrate thresholds on actual recordings; average log probability is not a universal percentage confidence score. Flag review candidates without silently replacing text or fabricating times. Add coverage checks between original transcript text and imported editable text so incomplete alignment/sentence output cannot silently omit spoken content.

Build a small reviewed English-source test set covering accents, names, numbers, negation, quiet/noisy speech, music, pauses, sentence boundaries crossing ASR chunks and overlapping speech. Measure WER, names/numbers/negation errors, word and caption onset/offset error distributions, and manual correction time. Evaluate unpadded alignment separately from the intentional 50 ms display padding. Use bilingual review for translation meaning and glossary consistency; same-model meaning checks are useful checks, not independent ground truth.

The current default is `medium`; GPU recognition uses FP16 and CPU uses INT8. Compare candidate larger models and batch settings against this reference set before changing the default. Keep the selected model stable during recovery. Approved English terminology could optionally inform upstream ASR prompt/hotword options, but it needs evaluation for unwanted bias/hallucination before becoming a default.

### 6. Speech startup and repeat audio preparation dominate short operations

Evidence: [fresh worker and PCM preparation](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/whisperx.ts#L32), [full audio read](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/scripts/whisperx_worker.py#L132), and [model load/unload](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/scripts/whisperx_worker.py#L163).

The current fresh-process approach gives reliable cancellation and releases memory; keep those properties. The warm tiny.en profile spent only about 1.07 seconds in recognition/alignment inference out of 15.55 seconds total. Both cold and warm stage timings should be surfaced so tuning targets the actual cost. Add timings for imports, audio preparation, model loading, inference, alignment and finalization, with actual model/device/precision/batch provenance.

Evaluate a bounded idle worker that retains imported modules and, where safe, reusable CPU state. Keep one speech slot and one active GPU-heavy stage, unload GPU models between recognition and alignment, and destroy/recreate the worker on cancellation, OOM or failed health checks. A short idle timeout and explicit release avoid permanent GPU occupancy. Validate output equivalence and memory release before enabling reuse by default.

Re-alignment currently converts and loads the entire media even for a small selection. Reuse prepared PCM by media fingerprint with a bounded derived cache, or extract selected windows with explicit offsets and preserve original/local timestamp provenance. Do not introduce arbitrary audio cuts that change ASR context or sentence grouping. For long recordings, reduce temporary audio copies and evaluate memory mapping without changing upstream model inputs. The float32 audio array alone is about 230 MB per hour, before temporary copies and models.

### 7. Translation retries can repeat work that is already useful

Evidence: [sparse batching](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/shared/translation.ts#L73), [draft and meaning stages](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/translation.ts#L87), [meaning failure preservation](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/translation.ts#L131), and [request transport](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/ai.ts#L38).

The existing context, glossary, stable-ID checks, manual-edit protection, review preservation and second meaning pass are valuable. Keep them. With alternating reviewed/eligible captions, the probe produced ten times as many default API requests for the same number of eligible captions. Improve sparse batching within a token budget, explicitly preserving intervening context-only captions and the output ID contract.

Represent drafting and verification as separate states. A failed meaning check preserves the draft, but it becomes an ordinary draft and is excluded by default `needed` batching. Retrying selected captions regenerates the draft rather than retrying only verification. A cache keyed by exact source/context/guidance, model/provider settings and draft text can resume checks safely; edits must invalidate the relevant cache. Cancellation during the current meaning call likewise does not commit its initial draft, so resumable intermediate state would avoid that repeated work.

Record per-stage latency, request count, retry reason and provider token usage where supplied. Use structured-output capability configuration per endpoint/model, and split a batch after a confirmed truncation instead of repeating the same oversized request. After quality tests, evaluate provider-aware concurrency of two independent batches; preserve per-batch draft→meaning order, cancellation, fatal-error stopping and stale-response guards. This is a candidate optimization, not a measured live-provider speedup. Keep meaning checking enabled in the quality-focused workflow.

### 8. Timing and export need stronger final checks

Evidence: [frame stepping](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L251), [playback time updates](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L1185), [SRT formatter](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/shared/model.ts#L229), and [export handler](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/main/main.ts#L935).

Frame stepping adds `1 / avg_frame_rate` to current time. That is a nominal time step, not a guarantee of the next actual frame on variable-frame-rate media. Validate a VFR fixture and use actual frame presentation times/on-demand frame indexing where necessary. Frame-driven preview updates should be isolated from the caption editor; test short cues while ensuring exact display changes do not trigger full-list renders.

Exports currently allow stale/failed/unreviewed translations and uncertain alignment without a final issue summary. Add a concise readiness summary with direct navigation to issues and an explicit user choice; human-reviewed acceptance should remain possible. Also handle blank lines inside SRT cue text: the review reproduced `First paragraph.\n\nSecond paragraph.` exporting into a form that this app's own parser reads back as only `First paragraph.`. Normalize/flag this at export while preserving original project text and raw results.

### 9. A keyboard shortcut can change content unexpectedly

**Confirmed UI defect.** Evidence: [keyboard handler](https://github.com/BoazMao/Raccoon-Studio/blob/ce3e8dd206af16cbcc7161f05a88a8c3468b3148/src/renderer/index.tsx#L538).

The Save shortcut checks lowercase `e.key === "s"`, while Ctrl+Shift+S produces uppercase `S`. It falls through to the later lowercase Split handler. In the actual UI probe, Ctrl+Shift+S invoked zero Save As dialogs and changed one caption into two. Normalize key matching and require the intended modifier combination before editing shortcuts. Add a regression test. Group text edits into useful undo transactions and apply the same history bound to drag completion; pointer-up currently bypasses the 100-entry cap in `commit`.

## Secondary work

- Cancel superseded waveform jobs and cap media analysis concurrency. Ignoring old results does not stop their FFmpeg/CPU work.
- Separate fast runtime/GPU readiness from recursive disk-size inventory. Settings currently walks environment files on relevant job-state changes and may overlap scans.
- Managed installation checks free space on the selected runtime drive, while `uv --no-cache` uses a temporary directory. The installed uv reported a directory on `C:\Users\Bo\AppData\Local\Temp` even for the D: runtime. Scope installer TEMP/TMP to a checked staging location or check both volumes. Consider a bounded repair cache only after measuring its download-speed versus disk-space tradeoff.
- Add PR CI for type checking, functional regressions and performance budgets. The only workflow is release-triggered; routine PRs do not automatically run these checks. Keep real GPU tests opt-in/on suitable hardware and quality corpus tests distinct from mocked transport tests.
- Make published versions immutable before the next release: the current workflow can force-move an existing version tag and overwrite its assets. Use a new version and generated change notes for new code. This is a publication correctness issue, outside the immediate speed work.
- Keep the existing bundled media tools and optional managed runtime arrangement while performance work proceeds. UI minification has a useful side effect on size, but removing Electron/FFmpeg or replacing inference engines would introduce a different compatibility/accuracy project.

## Suggested delivery sequence and gates

1. **Baseline and fast build win:** add the small quality corpus harness and stage telemetry; switch the release renderer to production. Run current functional tests and record both UI speed and inference settings unchanged.
2. **Responsive editing and safe saves:** isolate/virtualize UI work, remove quadratic lookups, move save/load CPU work off main, coalesce autosaves, and make archives survive undo/cancellation. Add regression tests for the reproduced defects and verify long-project editing during saves.
3. **Speech latency:** evaluate warm-worker/import reuse and selected-audio preparation with the same model, precision, text, timing, 50 ms padding and full raw output requirements. Keep a cold path and forced-worker-restart tests. Reject speed changes that exceed agreed transcript/timing regression limits.
4. **Translation latency and quality:** add resumable verification and sparse batching, then evaluate limited concurrency. Use reviewed English→Chinese examples for omissions, additions, negation, names/numbers and terminology, alongside malformed-response/cancellation/stale-edit tests.
5. **Transport/export:** add VFR stepping tests and export readiness/format checks. Address packaging and installation refinements afterward unless they block testing.

Use end-to-end wall time, per-stage wall time, UI median/p95 latency, memory/VRAM high-water marks, correction time, transcript error rates and timing-error distributions as separate metrics. Do not label a faster result as an improvement if it silently changes model quality, drops raw outputs or makes manual correction slower.

Review evidence: `.tools/test-work/code-review/ui-results.json`, `recovery-translation-results.json`, `benchmark.json`, `render-results.json`, `render-production-results.json`, `worker-profile.json`, and the real `worker-output.json`. The adjacent scripts reproduce the controlled probes and stage profiling. No application fixes, PR or release were made as part of this review.

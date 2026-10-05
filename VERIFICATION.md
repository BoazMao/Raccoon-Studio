# Verification — 30 September 2026

Tested on Windows x64 using Electron 44.4.5 and Node.js 24.19.0.

| Check | Result |
| --- | --- |
| TypeScript (`tsc --noEmit`) | Passed |
| Core automated tests | 27 passed, 0 failed |
| Bundled download/fallback tools | Checksum-verified yt-dlp 2026.08.19 and whisper.cpp v1.7.6 CPU runtime; packaged metadata/download/merge/import, real tiny.en fallback transcription with DTW, translation retry/review, separate SRT and cancellation passed |
| WhisperX size measurement | Current Python 3.12.14 / PyTorch 2.8.0+cpu installation plus base Python files: 2,320,171,526 bytes unpacked and 609,875,259 bytes ZIP-compressed (level 6), excluding downloaded recognition/alignment model caches. This measures a future bundle's approximate size, not a validated relocatable runtime. |
| Dependency audit | 0 known vulnerabilities at installation/audit time |
| Real H.264/AAC video | Play, pause, seek and 30-fps frame stepping passed |
| Waveform | Real FFmpeg PCM extraction and displayed peaks passed |
| Timeline | Group drag, split, merge, clipboard shortcuts, bulk delete, undo/redo, icon-only overlap warnings with independent selection highlighting and waveform overlay/zoom passed; one block row shows source until replaced by target text |
| Persistence | Unicode roundtrip, ordered concurrent writes and UI save/reopen passed |
| Translation state | Stale marking, manual-edit protection, failure, retry and review passed |
| Download | Real yt-dlp metadata and fresh local DASH download, separate audio/video merging, final-file import passed |
| Local speech | Real WhisperX 3.8.6 CPU transcription and forced alignment of the JFK sample using tiny.en passed, including cached offline mode and Electron caption import/re-alignment. Multilingual tiny plus Chinese alignment also completed on synthetic Mandarin speech. GPU and broader natural-speech timing accuracy were not benchmarked. Legacy whisper.cpp validation remains available. |
| Translation transport | OpenAI-compatible local mock endpoint passed; no live AI provider or translation quality claim |
| Export | Separate source and target SRT files verified on disk |
| Cancellation | Real child-process tree and in-flight HTTP request cancellation passed |
| Compatible preview | FFmpeg H.264/AAC conversion and playback of the resulting file passed |
| Packaged application | Fresh profile and saved bare `ffmpeg`/`ffprobe` settings selected bundled tools automatically; ASAR/preload launch, bundled WhisperX worker/runtime setup check, real video playback and waveform passed |
| Raccoon Studio branding | Supplied ICO copied byte-for-byte; header icon and window title verified in development and unpacked builds; profile migration and legacy clipboard compatibility passed |
| Portable executable | Previous build only; not rebuilt for the WhisperX migration. Use the current unpacked app. |

The editor was launched and visually inspected from real Electron screenshots. Layout was adjusted so the video, linked text tracks, full-width timeline and compact task panel remain usable at the tested desktop size. Test-only native file dialogs are replaced by deterministic return values inside Playwright; the actual IPC, filesystem, media protocol and processing code runs unchanged.

The source archive contains reproducible tests. `scripts/e2e.cjs` generates its own media fixture. `scripts/pipeline.cjs` requires the external assets documented in README. `node scripts/package-smoke.cjs` validates `release/win-unpacked/Raccoon Studio.exe` after packaging. WhisperX is now the default engine and provides a separate forced-alignment stage plus re-alignment of corrected source text. Tests cover preserved IDs/translations, stale result protection, exact sentence text, 50 ms padding and short gaps, genuine overlaps, missing word times, full raw archives, replacement/edit races, Chinese character import, and save/reopen. Legacy DTW project data remains readable.

This workspace already contains the tools used for verification. Source-development paths are:

```text
FFmpeg:      node_modules\ffmpeg-static\ffmpeg.exe
FFprobe:     node_modules\ffprobe-static\bin\win32\x64\ffprobe.exe
yt-dlp:      .tools\test-assets\yt-dlp.exe
whisper.cpp: .tools\test-assets\whisper\Release\whisper-cli.exe
Legacy model: .tools\test-assets\ggml-tiny.en.bin
WhisperX:    .tools\whisperx\Scripts\python.exe
Test cache:  .tools\test-assets\whisperx-models
```

These paths are relative to the project folder. The unpacked app includes FFmpeg, FFprobe and the WhisperX worker. It discovers this checkout's Python environment automatically; Python and model caches are not bundled or committed. New builds install a private CPU Python/WhisperX environment through Settings → Install WhisperX. Published v0.1.1 uses the manual environment instructions from [WhisperX setup](WHISPERX_SETUP.md). Both need internet access for first model use (default medium). yt-dlp and whisper.cpp are bundled since v0.1.1. CPU tests used tiny models, not the default medium. Translation additionally needs a configured provider/model and, where required, an API key. No live-provider translation quality test was performed.

## Settings installer verification

The one-click installer completed a real private Python 3.12.14 and WhisperX 3.8.6 CPU installation. Recognition/alignment module imports passed. The new runtime also passed the real tiny.en transcription, forced alignment, re-alignment, archive preservation, mocked translation transport and SRT export pipeline using cached models. All 27 unit tests and the real-video Electron editing workflow passed. Unit tests include verification failure and mid-install cancellation preserving the previous active runtime. `npm run test:install` is an optional network integration test; it downloads dependencies and needs at least 6.5 GB free disk space. Models are excluded from the runtime installation.

PR review regressions cover cancellation while marker rename/settings persistence are pending, and shutdown awaiting cancellation cleanup before exit. Final runtime activation disables Cancel briefly; shutdown waits for activation or cleanup to settle.

## Saved waveform verification — 1 October 2026

Waveforms are now stored inside `.captionproj` as compressed PCM16 peak data. Source path, file size, modification time, and media duration determine whether the saved data can be reused. Invalid or damaged caches fall back to analysis, and waveform request IDs prevent obsolete results from replacing the current timeline. Waveform data is preserved across caption undo/redo independently of edit history.

Type checking, build, and all 31 unit tests passed. The real-video Electron workflow verified save/reopen with FFmpeg deliberately unavailable, rejection of an obsolete waveform result, and regeneration of corrupted cached data. Existing playback, waveform zoom/overlay, editing, clipboard, transcription import, undo/redo, and compatible-preview checks passed. Older project files remain compatible and acquire waveform data on their next save or autosave.

The same workflow also passed against the refreshed `release/win-unpacked/Raccoon Studio.exe` with its bundled media tools, using `$env:TEST_PACKAGED='1'; npm run test:e2e`. The media fixture is an actual eight-second H.264/AAC file generated from a test pattern and sine tone. Native file dialogs are replaced for automation, and an obsolete event is injected deliberately to exercise the race guard. These checks do not establish performance on long videos, real-footage timing quality, or live AI translation quality.

## Local context and translation pipeline — 1 October 2026

The local build adds section-based transcript analysis, editable approved description/style/glossary, source evidence, Simplified/Traditional Chinese choice, contextual translation batches, a default-on meaning check, and advisory readability flags. Suggestions and approved guidance are saved separately. Translation preserves reviewed captions and existing drafts by default, supports explicit selected/all-unreviewed replacement, validates complete ID mappings, retries transient transport and malformed responses, rejects obsolete results, and preserves completed batches on cancellation. Each applied batch is undoable.

Type checking, build, and all 41 unit tests passed. New tests use a real loopback HTTP server with controlled responses to verify analysis consolidation and evidence validation, invalid ID rejection/corrective retry, 429 retry, failed meaning checks retaining flagged drafts, cancellation retaining completed batches, safe application after edits, project persistence, and deterministic readability checks.

`npm run test:translation` passed against development Electron and the refreshed unpackaged Windows executable. It drives the actual UI through analysis, explicit guidance approval, reanalysis with a conflicting suggestion, translation plus meaning check, manual/reviewed protection, save/reopen, and stale-analysis detection. Screenshots were inspected; Save guidance remains visible while the panel scrolls. The existing real H.264/AAC media/editor regression workflow also passed in both modes. Tests replace native file dialogs and supply controlled AI responses; they do not measure live-provider translation accuracy or model quality. No live API key or paid AI request was used.

The refreshed unpackaged executable also passed `TEST_PACKAGED=1 TEST_WHISPERX=1 TEST_WHISPERX_OFFLINE=1 npm run test:pipeline`: actual yt-dlp metadata and DASH download, FFmpeg merge/import, cached WhisperX tiny.en CPU transcription and forced alignment, re-alignment and full archive persistence, controlled-provider translation failure/retry/review/source invalidation, separate SRT exports, and in-flight HTTP cancellation. Recognition used the existing JFK audio fixture; translation responses were deterministic test data rather than AI-generated translations.

## Download quality and reusable glossaries — 1 October 2026

Type checking, build, and all 45 unit tests passed. The added tests cover resolution filtering and capped format selectors, glossary validation and language isolation, duplicate policies, actual file roundtrips, concurrent global saves, and preservation of corrupt global files instead of overwriting them.

`npm run test:download` passed in development and against the refreshed unpackaged executable. FFmpeg generated a real two-resolution DASH fixture served over loopback HTTP. Actual yt-dlp metadata exposed 180p and 360p; each selected quality downloaded, merged with audio, automatically imported, and played at the requested resolution. FFprobe confirmed both video height and audio presence. Distinct output filenames prevented reuse of the other quality. This verifies the media/tool integration, not availability on every public video site. The quality-selector screenshot was visually inspected.

`npm run test:translation` also passed in both modes with added glossary UI coverage: real JSON export/import, keep/replace duplicate policies, global save/load, and reuse in another project. Native dialogs were automated; application IPC and filesystem operations were real. Translation provider responses remained controlled test data. These changes are local and have not been published in a release.

## Removal of AI context analysis — 1 October 2026

Removed the analysis UI, IPC request/event, and background implementation. Manual guidance, glossary operations, contextual translation, and meaning checks remain. Legacy saved analysis data remains readable for project compatibility but is not displayed or sent for analysis. Type checking, build, and all 44 remaining unit tests passed (the removed analysis feature's test was removed). The refreshed unpackaged app passed the actual Electron translation/glossary workflow using controlled HTTP responses, including verification that entering guidance makes no API requests. The UI test now saves a glossary removal before verifying restoration from global terms; identical guidance correctly disables Save guidance. The updated panel screenshot was inspected. Nothing was published.

## PR 10 review fixes — 5 October 2026

All 47 unit tests, type checking, build, and the development and refreshed unpackaged Electron translation workflows passed. New regressions verify that HTTP 400/401 meaning-check failures retain completed drafts with warning metadata and stop before the next batch; source or target language changes clear pair-specific terms while preserving description/style; and both aligned and unaligned splits plus merges clear obsolete translation findings. The actual Electron test also changes language with unsaved glossary terms and verifies they cannot be saved globally under the new pair. Translation HTTP responses are controlled local fixtures, not live-model quality evaluations. No release was published.


# Raccoon Studio

Raccoon Studio is a Windows desktop subtitle editor for turning a video into corrected, translated subtitles. Open a local video or download one from a URL, transcribe and align speech locally with WhisperX, edit captions against the video and waveform, translate into a second language, and export separate source and translated SRT files.

The current language choices are **English and Chinese**, with English-to-Chinese subtitling as the main workflow. Downloads, transcription, alignment, and translation run as cancellable background tasks so you can keep using the editor.

## What it does

- Download video through URL
- Video preview with playback, seeking, and frame stepping.
- A zoomable waveform timeline with caption operations.
- Local WhisperX transcription with automatic forced alignment.
- Source and translation text side by side for easier translation.
- AI Translation through a configurable OpenAI-compatible API, with stale translations and failures flagged for review.
- Project save/reopen, autosave recovery, and separate SRT export for each language.

## Download and run

**Requirements:** Windows 10 or 11, 64-bit x64.

1. Open the [latest release](https://github.com/BoazMao/Raccoon-Studio/releases/latest).
2. Download `Raccoon-Studio-<version>-win-x64.zip` from **Assets**.
3. Extract the entire ZIP.
4. Run **Raccoon Studio.exe**.
5. Open **Settings** to configure the dependencies for the features you want to use.

## Dependencies

You can open videos, edit captions, save projects, and export subtitles using the downloaded app. WhisperX transcription and AI translation require additional setup:

| Dependency                             | Used for                                                                                                  | Included in the Windows release?                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Electron                               | Desktop application and video playback                                                                    | Yes                                                               |
| FFmpeg and FFprobe                     | Media inspection, waveform extraction, audio preparation, download merging, and compatible video previews | Yes; selected automatically                                       |
| 64-bit Python 3.10–3.13                | Running WhisperX locally                                                                                  | No                                                                |
| WhisperX 3.8.6 and Transformers 4.57.6 | Speech recognition and forced alignment                                                                   | Installed through Settings in new builds; manual script in v0.1.1 |
| Recognition and alignment models       | Recognizing speech and matching words to audio                                                            | No; downloaded on first use                                       |
| yt-dlp                                 | Video URL metadata preview and download                                                                   | Yes, since v0.1.1                                                 |
| whisper.cpp CPU fallback               | Optional transcription engine without Python                                                              | Yes, since v0.1.1; GGML models remain external                    |


### Local transcription: WhisperX

In new builds, open **Settings** and click **Install WhisperX**. Progress and cancellation appear in the task panel. The app downloads its own private Python 3.12.14 and installs WhisperX 3.8.6, Transformers 4.57.6, and CPU PyTorch 2.8.0. You do not need to install Python yourself. After verification, the app selects the installed Python executable, WhisperX engine, and CPU automatically. A failed or cancelled attempt preserves the previous working runtime.

Allow at least **6.5 GB free disk space** for installation, including temporary downloads. Dependency downloads are approximately **600 MB** and the installed runtime occupies approximately **2.3 GB**, excluding models. These are approximate and can vary with dependency versions. The runtime lives under the app's user-data folder in `runtime/whisperx`, outside the application folder, so replacing the unpackaged app does not remove it. No administrator access or API key is required.

Click **Check WhisperX setup**, then choose a recognition model. The default is `medium`
First use needs internet access to download recognition, speech-detection, sentence, and language-specific alignment data. Audio processing stays local. After warming the cache, **Use cached models only** prevents new model downloads. Models are downloaded separately; Python is installed privately by the Settings installer in new builds.

CPU mode does not require CUDA. NVIDIA GPU mode requires a compatible driver, CUDA libraries, and CUDA-enabled PyTorch; see [WhisperX setup, GPU, and offline instructions](WHISPERX_SETUP.md). GPU operation has not been benchmarked in this project.

The release includes the optional **whisper.cpp legacy fallback** (`whisper-cli.exe` v1.7.6 and its CPU runtime DLLs). Choose it in Settings and select a compatible model; models are not bundled. This engine is independent of Python and WhisperX. You may also select a custom executable from the [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases).


### Download quality

After **Preview**, choose **Video quality**: Best available, or one of the reported resolutions as an upper limit (for example, 720p or lower). Audio is included when available. A capped choice will not fall back to a higher resolution. Different downloaded formats have distinct filenames so a previous higher-quality download is not reused by mistake. Sites that do not report resolutions offer Best available only.

### AI translation

In **Settings**, enter:

- Your provider's OpenAI-compatible base URL, such as `https://your-provider.example/v1`.
- An exact translation-capable model ID available from that provider.
- An API key if the provider requires one.

The app calls `/chat/completions`. HTTPS is required for remote providers; local servers may use loopback HTTP, such as `http://127.0.0.1:1234/v1`.

The local development build adds the complete translation pipeline:

- Open **Translation context** to enter a video description, tone/style, and glossary manually. Choose Simplified/Traditional Chinese, then click **Save guidance**. Guidance is saved with the project and used in translation requests.
- In the glossary, **Save to global** merges the displayed terms into the app's reusable glossary for this language pair and Chinese variant, updating matching terms. **Load global** copies them into the current project's draft guidance. **Save to file** exports a versioned JSON glossary; **Import file** loads one. Description, transcript, and project-specific caption references are excluded from portable/global glossaries. Loading keeps existing project terms by default; choose **Use imported terms** to replace duplicates. Review loaded terms and click **Save guidance** to use them for translation. The global library lives in `global-glossaries.json` in the app's user-data directory.
- **Translate →** sends consecutive batches (up to 20 captions, with surrounding source captions and approved guidance). The app validates every returned ID before applying text. Timings stay under editor control.
- **Check meaning**, enabled by default, makes a second API request to compare the draft against the source and context. Results remain drafts for human review; unresolved meaning concerns and line-length/reading-speed warnings appear in the caption list. Readability warnings are advisory (Chinese: 16 characters/line and 9 characters/second; English: 42 and 20; two lines maximum).
- The default scope translates only empty, stale, and failed captions. Use **Selected captions (replace drafts)** or **All unreviewed (replace drafts)** deliberately to redo existing drafts. Reviewed captions are skipped. Editing the description/style invalidates existing translations; changing a glossary term marks matching source captions stale.
- Requests time out after 90 seconds, retry transient failures with bounded backoff, and retry invalid JSON/ID mappings up to three total attempts. Authentication/configuration errors stop the job. Cancel preserves completed batches. Each applied batch is one undo step; results are rejected if the relevant source/context/guidance or your target text changed while the request ran.

Official OpenAI requests use strict structured output for translation and meaning checks; compatible endpoints use JSON prompts with the same local validation. Use a model that supports the selected endpoint's Chat Completions API. Meaning checks add API calls. `npm run test:translation` exercises the editor against a controlled local HTTP provider; it does not measure live-model translation quality.

Translation sends caption text to the configured endpoint. Transcription does not upload audio. API keys are excluded from project files and encrypted in Windows settings; if encryption is unavailable, the key is kept only in memory.

Video preview shows the translated subtitle when it is nonempty, falling back to the source text otherwise.

## Basic workflow

1. **Import:** Open a local video or download one from a URL.
2. **Transcribe:** Choose the source language and run WhisperX. Recognition and forced alignment run before captions are imported.
3. **Correct:** Edit text and timing against the waveform and preview. After source edits, use **Re-align selection** or **Re-align all**. Overlap icons and **Check sync** flags identify captions to inspect.
4. **Translate and review:** Choose the target language, translate, correct the results, and mark captions reviewed. Source changes make existing translations stale.
5. **Save and export:** Save a `.captionproj` project, then export separate source and translated SRT files.


Raccoon Studio is [MIT licensed](LICENSE). Bundled FFmpeg is GPL-3.0-or-later; its license and build information are included under `resources/tools`. See [FFmpeg's licensing information](https://ffmpeg.org/legal.html).

New builds include whisper.cpp under MIT and the standalone yt-dlp executable under GPLv3+, with upstream source references, license texts, and third-party notices in `resources/tools`. The build downloads pinned upstream binaries and verifies their SHA-256 hashes; binaries and models are not committed to this repository.

[Subtitle Edit](https://github.com/SubtitleEdit/subtitleedit) and [SmartSub](https://github.com/buxuku/SmartSub) informed the media/job separation and transcription/translation workflows. The interface and implementation are original.

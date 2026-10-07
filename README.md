# Raccoon Studio

A Windows desktop subtitle editor for importing video or audio, transcribing and aligning speech locally, editing captions against a waveform, translating, and exporting subtitles or timestamped text. Supports **English and Chinese**, including Simplified and Traditional Chinese translations.

## Download and run

Requires **Windows 10 or 11, x64**.

1. Download the Windows ZIP from the [latest release](https://github.com/BoazMao/Raccoon-Studio/releases/latest).
2. Extract the entire archive.
3. Run `win-unpacked/Raccoon Studio.exe`. Keep the extracted files together.

Node.js is only needed for development.

## Dependencies and setup

**Included:** Electron, FFmpeg, FFprobe, yt-dlp, and the whisper.cpp CPU fallback.

- **WhisperX:** Open **Settings → Install WhisperX** for CPU, or **Install GPU support** for NVIDIA CUDA. The app installs private Python and locked dependencies. Allow **6 GiB free for CPU or 12 GiB for GPU** during installation, plus model space. GPU support needs a compatible NVIDIA driver; a separate Python installation or full CUDA toolkit is unnecessary. Choose **Auto**, **CPU**, or **NVIDIA GPU**, then run **Check WhisperX setup**.
- **Models:** Recognition and alignment models download on first use. The default recognition model is `medium`. After downloading, enable **Use cached models only** for offline transcription.
  The tested managed installations occupy approximately **1.2 GiB (CPU)** or **5.1 GiB (CUDA)** before models. Advanced Settings lets you choose another drive. These GPU and audio features currently require the local source/unpackaged build; they are not in the published v0.1.3 release.
- **whisper.cpp fallback:** Select it in Settings and choose a compatible GGML model. Models are not bundled.
- **Translation:** In Settings, enter an OpenAI-compatible endpoint, model ID, and API key if required. Translation sends caption text to that endpoint; transcription and alignment stay local.

See [WhisperX setup](WHISPERX_SETUP.md) for manual installation, GPU, and offline details.

## Basic workflow

1. **Import:** Open a local video or audio file, or preview a video URL, select its quality, and download.
2. **Transcribe:** Choose the source language and run WhisperX. Captions are aligned to the audio automatically.
3. **Edit:** Correct text and timing against the video and waveform. Re-align captions after source edits.
4. **AI Translate Support:** Choose the target language. Optionally enter a description, style, and glossary under **Translation context**, then **Save guidance**. Glossaries can be saved globally or exported and imported. API is not included.
5. **Review:** Check translations, timing, and flagged issues. The preview shows translated subtitles when available. Source edits mark translations stale.
6. **Save and export:** Save a `.captionproj` to retain your work. Choose **SRT · both tracks** or **Timestamped text · source/translation**, then export. Audio imports default to source text with start/end timestamps. Autosave supports recovery.

## Run from source

Requires Windows x64, **Node.js 22+**, npm, and Git.

```powershell
git clone https://github.com/BoazMao/Raccoon-Studio.git
cd Raccoon-Studio
npm ci
npm run dev
```

Build an unpackaged Windows app:

```powershell
npm run prepare:tools
npm run build
npx electron-builder --win dir --x64 --publish never
```

Run `release/win-unpacked/Raccoon Studio.exe`. Configure transcription and translation through Settings as above.

## License

Raccoon Studio and whisper.cpp are MIT licensed. Bundled FFmpeg is GPL-3.0-or-later; standalone yt-dlp is GPLv3+. See [LICENSE](LICENSE) and the bundled notices in `resources/tools`.

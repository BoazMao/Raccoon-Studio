import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  protocol,
  safeStorage,
  clipboard,
} from "electron";
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProjectSchema, srt, type Project } from "../shared/model";
import { captionsFromWhisperJson, dtwPreset } from "../shared/alignment";
import type { Settings, Requests, Event } from "../shared/ipc";
import { Jobs, run } from "./jobs";
import { whisperXJob } from "./whisperx";
import { readProject, writeProject } from "./storage";
import { migrateProfile } from "./profile";
import { toolDefaults, restoreTool, persistTool } from "./tools";
import { installWhisperX, managedPython } from "./install-whisperx";
import {
  restoreWaveform,
  sameWaveformSource,
  saveWaveform,
  waveformSource,
} from "./waveform";
import { MAX_WAVEFORM_PEAKS, WAVEFORM_SAMPLE_RATE } from "../shared/waveform";
import { validateTranslationEndpoint } from "./ai";
import { translateProject } from "./translation";
import { TranslationOptionsSchema } from "../shared/translation";
import { videoPreview, downloadFormat } from "../shared/download";
import { GlossaryFileSchema, GlossaryScopeSchema } from "../shared/glossary";
import {
  readGlossary,
  writeGlossary,
  loadGlobalGlossary,
  saveGlobalGlossary,
} from "./glossary";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
let canClose = false;
let window: BrowserWindow;
let settings: Settings;
const allowed = new Map<string, string>();
const files = new Map<string, string>();
const emit = (event: Event) => {
  if (window && !window.isDestroyed())
    window.webContents.send("studio:event", event);
};
const jobs = new Jobs(emit);
const data = () => app.getPath("userData");
const settingsFile = () => path.join(data(), "settings.json");
function registerMedia(file: string) {
  let id = files.get(file);
  if (!id) {
    id = randomUUID();
    files.set(file, id);
    allowed.set(id, file);
  }
  return `media://local/${id}`;
}
function trustedFile(file: string) {
  if (!files.has(file)) throw Error("Open this media file first");
  return file;
}
function handle<K extends keyof Requests>(
  name: K,
  fn: (
    input: Requests[K]["input"],
  ) => Promise<Requests[K]["output"]> | Requests[K]["output"],
) {
  ipcMain.handle("studio:" + name, (event, input) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw Error("Untrusted sender");
    return fn(input);
  });
}
const project = (p: unknown) => ProjectSchema.parse(p);
function validUrl(raw: string) {
  const u = new URL(raw);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("Use an HTTP or HTTPS video URL");
  return u.href;
}
async function inspect(file: string, signal: AbortSignal) {
  const raw = await run(
    settings.ffprobe,
    ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
    signal,
  );
  const info = JSON.parse(raw),
    video = info.streams.find((s: any) => s.codec_type === "video");
  if (!video) throw Error("The file has no video stream");
  const [n, d] = String(video.avg_frame_rate || "30/1")
    .split("/")
    .map(Number);
  return {
    path: file,
    duration: Number(info.format.duration) || Number(video.duration) || 0,
    fps: n / d || 30,
  };
}
async function tempDir() {
  const dir = path.join(data(), "cache", randomUUID());
  await mkdir(dir, { recursive: true });
  return dir;
}
function progress(duration: number, update: (n: number, m: string) => void) {
  let carry = "";
  return (text: string) => {
    carry += text;
    const lines = carry.split(/[\r\n]/);
    carry = lines.pop() || "";
    for (const line of lines) {
      const m = line.match(/out_time_us=(\d+)/);
      if (m)
        update(
          (Number(m[1]) / 1e6 / Math.max(1, duration)) * 100,
          "Processing media",
        );
    }
  };
}
async function setup() {
  const runtimeRoot = path.join(data(), "runtime", "whisperx");
  const managed = await managedPython(runtimeRoot);
  const defaults: Settings = {
    ...toolDefaults(process.resourcesPath, app.getAppPath(), existsSync),
    modelPath: "",
    speechEngine: "whisperx",
    whisperxPython: (() => {
      const candidate = path.resolve(
        app.isPackaged
          ? path.join(path.dirname(process.execPath), "../..")
          : app.getAppPath(),
        ".tools/whisperx/Scripts/python.exe",
      );
      return managed || (existsSync(candidate) ? candidate : "python");
    })(),
    whisperxModel: "medium",
    whisperxDevice: "cpu",
    whisperxCache: path.join(data(), "models", "whisperx"),
    whisperxOffline: false,
    endpoint: "https://api.openai.com/v1",
    model: "",
    apiKey: "",
  };
  try {
    const raw = JSON.parse(await readFile(settingsFile(), "utf8"));
    settings = {
      ...defaults,
      ...raw,
      ffmpeg: restoreTool("ffmpeg", raw.ffmpeg, defaults.ffmpeg),
      ffprobe: restoreTool("ffprobe", raw.ffprobe, defaults.ffprobe),
      ytdlp: restoreTool("ytdlp", raw.ytdlp, defaults.ytdlp),
      whisper: restoreTool("whisper", raw.whisper, defaults.whisper),
      whisperxPython:
        raw.whisperxPython === "python" || !raw.whisperxPython
          ? defaults.whisperxPython
          : raw.whisperxPython,
      apiKey:
        raw.secret && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(Buffer.from(raw.secret, "base64"))
          : "",
    };
  } catch {
    settings = defaults;
  }
  handle("closed", () => {
    canClose = true;
    window.close();
  });
  handle("settings", () => settings);
  handle("glossaryImport", async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: "Import glossary",
      properties: ["openFile"],
      filters: [{ name: "Raccoon Studio glossary", extensions: ["json"] }],
    });
    if (selected.canceled) return null;
    return readGlossary(selected.filePaths[0]);
  });
  handle("glossaryExport", async (input) => {
    const glossary = GlossaryFileSchema.parse(input);
    const selected = await dialog.showSaveDialog(window, {
      title: "Export glossary",
      defaultPath: `glossary-${glossary.sourceLanguage}-${glossary.targetLanguage}.json`,
      filters: [{ name: "Raccoon Studio glossary", extensions: ["json"] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    await writeGlossary(selected.filePath, glossary);
    return selected.filePath;
  });
  handle("glossaryLoadGlobal", (input) =>
    loadGlobalGlossary(
      path.join(data(), "global-glossaries.json"),
      GlossaryScopeSchema.parse(input),
    ),
  );
  handle("glossarySaveGlobal", (input) =>
    saveGlobalGlossary(
      path.join(data(), "global-glossaries.json"),
      GlossaryFileSchema.parse(input),
    ),
  );
  handle("clipboardRead", () => clipboard.readText());
  handle("clipboardWrite", (text) => {
    clipboard.writeText(z.string().max(10000000).parse(text));
  });
  handle("configure", async (input) => {
    settings = z
      .object({
        ffmpeg: z.string().min(1),
        ffprobe: z.string().min(1),
        ytdlp: z.string().min(1),
        whisper: z.string().min(1),
        modelPath: z.string(),
        speechEngine: z.enum(["whisperx", "whispercpp"]).default("whisperx"),
        whisperxPython: z.string().min(1).default(defaults.whisperxPython),
        whisperxModel: z.string().min(1).default("medium"),
        whisperxDevice: z.enum(["cpu", "cuda"]).default("cpu"),
        whisperxCache: z.string().min(1).default(defaults.whisperxCache),
        whisperxOffline: z.boolean().default(false),
        endpoint: z.string().url(),
        model: z.string(),
        apiKey: z.string(),
      })
      .parse(input);
    await persistSettings();
  });
  async function persistSettings() {
    const { apiKey, ...rest } = settings;
    await writeFile(
      settingsFile(),
      JSON.stringify({
        ...rest,
        ffmpeg: persistTool("ffmpeg", rest.ffmpeg, defaults.ffmpeg),
        ffprobe: persistTool("ffprobe", rest.ffprobe, defaults.ffprobe),
        ytdlp: persistTool("ytdlp", rest.ytdlp, defaults.ytdlp),
        whisper: persistTool("whisper", rest.whisper, defaults.whisper),
        secret:
          apiKey && safeStorage.isEncryptionAvailable()
            ? safeStorage.encryptString(apiKey).toString("base64")
            : undefined,
      }),
    );
  }
  handle("pick", async (kind) => {
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters:
        kind === "media"
          ? [
              {
                name: "Video",
                extensions: ["mp4", "webm", "mkv", "mov", "avi", "m4v"],
              },
            ]
          : kind === "model"
            ? [{ name: "Whisper model", extensions: ["bin"] }]
            : [{ name: "Executable", extensions: ["exe"] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if (kind === "media") registerMedia(file);
    return file;
  });
  handle("url", (file) => registerMedia(trustedFile(file)));
  handle("open", async () => {
    const r = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [
        { name: "Raccoon Studio project", extensions: ["captionproj"] },
      ],
    });
    if (r.canceled) return null;
    const p = await readProject(r.filePaths[0]);
    if (p.media) {
      registerMedia(p.media.path);
      if (p.media.previewPath) registerMedia(p.media.previewPath);
    }
    return { project: p, path: r.filePaths[0] };
  });
  handle("recover", async () => {
    try {
      const p = await readProject(path.join(data(), "recovery.captionproj"));
      if (p.media) {
        registerMedia(p.media.path);
        if (p.media.previewPath) registerMedia(p.media.previewPath);
      }
      return p;
    } catch {
      return null;
    }
  });
  handle("save", async (input) => {
    const p = project(input.project);
    let file = input.autosave
      ? path.join(data(), "recovery.captionproj")
      : input.path;
    if (!file) {
      const r = await dialog.showSaveDialog(window, {
        defaultPath: p.name + ".captionproj",
        filters: [
          { name: "Raccoon Studio project", extensions: ["captionproj"] },
        ],
      });
      if (r.canceled) return null;
      file = r.filePath;
    }
    if (!file) return null;
    if (input.autosave)
      await writeProject(
        path.join(data(), "recovery", p.id + ".captionproj"),
        p,
      );
    await writeProject(file, p);
    return file;
  });
  handle("media", (input) => {
    const file = trustedFile(z.string().parse(input.path));
    return jobs.start("Inspect video", async (signal, update) => {
      const media = await inspect(file, signal);
      signal.throwIfAborted();
      emit({ type: "media", projectId: input.projectId, media });
      update(100, "Video ready");
    });
  });
  handle("wave", (input) => {
    const file = trustedFile(input.path);
    z.string().uuid().parse(input.requestId);
    z.number().finite().nonnegative().parse(input.duration);
    const ffmpeg = settings.ffmpeg;
    return jobs.start("Waveform", async (signal, update) => {
      const source = await waveformSource(file, input.duration);
      signal.throwIfAborted();
      const cached = await restoreWaveform(input.cached, source);
      signal.throwIfAborted();
      if (
        cached &&
        sameWaveformSource(source, await waveformSource(file, input.duration))
      ) {
        signal.throwIfAborted();
        emit({
          type: "wave",
          projectId: input.projectId,
          requestId: input.requestId,
          ...cached,
          reused: true,
        });
        update(100, "Saved waveform loaded");
        return;
      }
      const peaks: number[] = [];
      let left: Buffer = Buffer.alloc(0),
        peak = 0,
        count = 0,
        overflow = false;
      // Millisecond detail for editing; bound IPC/memory for very long media.
      const bucket = Math.max(
        8,
        Math.ceil((input.duration * WAVEFORM_SAMPLE_RATE) / MAX_WAVEFORM_PEAKS),
      );
      await run(
        ffmpeg,
        [
          "-v",
          "error",
          "-i",
          file,
          "-vn",
          "-ac",
          "1",
          "-ar",
          String(WAVEFORM_SAMPLE_RATE),
          "-f",
          "s16le",
          "-progress",
          "pipe:2",
          "pipe:1",
        ],
        signal,
        progress(input.duration, update),
        (b) => {
          const chunk = Buffer.concat([left, b]);
          const size = chunk.length - (chunk.length % 2);
          for (let i = 0; i < size; i += 2) {
            peak = Math.max(peak, Math.abs(chunk.readInt16LE(i)) / 32768);
            if (++count >= bucket) {
              if (peaks.length < MAX_WAVEFORM_PEAKS) peaks.push(peak);
              else overflow = true;
              peak = 0;
              count = 0;
            }
          }
          left = chunk.subarray(size);
        },
      );
      if (count) peaks.push(peak);
      if (overflow || peaks.length > MAX_WAVEFORM_PEAKS)
        throw Error(
          "Audio is longer than the recorded media duration. Reopen the video to inspect it again.",
        );
      signal.throwIfAborted();
      if (
        !sameWaveformSource(source, await waveformSource(file, input.duration))
      )
        throw Error(
          "Media changed during waveform analysis. Relink the video and try again.",
        );
      update(99, "Compressing waveform");
      const waveform = await saveWaveform(peaks, source, bucket);
      signal.throwIfAborted();
      emit({
        type: "wave",
        projectId: input.projectId,
        requestId: input.requestId,
        peaks,
        waveform,
        reused: false,
      });
    });
  });
  handle("preview", async (raw) => {
    const url = validUrl(raw);
    let result = "",
      failure: unknown;
    const id = jobs.start("URL preview", async (signal, update) => {
      try {
        result = await run(
          settings.ytdlp,
          ["--no-playlist", "--skip-download", "--dump-single-json", "--", url],
          signal,
        );
        update(100, "Metadata ready");
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    while (jobs.active.has(id)) await new Promise((r) => setTimeout(r, 50));
    if (failure) throw failure;
    if (!result) throw Error("yt-dlp returned no video metadata.");
    return videoPreview(JSON.parse(result));
  });
  handle("download", async (input) => {
    const url = validUrl(input.url);
    const format = downloadFormat(input.quality);
    const config = { ...settings };
    const r = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose download folder",
    });
    if (r.canceled) return "";
    const folder = r.filePaths[0];
    return jobs.start("Download video", async (signal, update) => {
      let final = "",
        carry = "";
      await run(
        config.ytdlp,
        [
          "--no-playlist",
          "--newline",
          "--no-simulate",
          "--format",
          format,
          "--ffmpeg-location",
          config.ffmpeg,
          "--merge-output-format",
          "mp4",
          "--print",
          "after_move:FINAL:%(filepath)s",
          "-o",
          path.join(folder, "%(title).120B [%(id)s] [%(format_id)s].%(ext)s"),
          "--",
          url,
        ],
        signal,
        (text) => {
          carry += text;
          const lines = carry.split(/[\r\n]/);
          carry = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("FINAL:")) final = line.slice(6);
            const m = line.match(/(\d+(?:\.\d+)?)%/);
            if (m) update(+m[1], line.trim());
            else if (line.includes("[Merger]"))
              update(99, "Merging audio and video");
          }
        },
      );
      if (carry.startsWith("FINAL:")) final = carry.slice(6);
      if (!final) throw Error("yt-dlp did not report a final merged file");
      await stat(final);
      registerMedia(final);
      const media = await inspect(final, signal);
      signal.throwIfAborted();
      emit({ type: "media", projectId: input.projectId, media });
    });
  });
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, "workers", "whisperx_worker.py")
    : path.join(__dirname, "whisperx_worker.py");
  let installing: string | undefined;
  handle("installSpeech", () => {
    if (installing && jobs.active.has(installing)) return installing;
    installing = jobs.start(
      "WhisperX installation",
      async (signal, update, beginCommit) => {
        const python = await installWhisperX(runtimeRoot, signal, update, {
          beginCommit,
        });
        settings = {
          ...settings,
          whisperxPython: python,
          speechEngine: "whisperx",
          whisperxDevice: "cpu",
        };
        await persistSettings();
        emit({ type: "speechInstalled", python });
        update(
          100,
          "WhisperX installed. Models download on first transcription.",
        );
      },
    );
    return installing;
  });
  handle("checkSpeech", () => {
    const config = { ...settings };
    return jobs.start("WhisperX setup", async (signal, update) => {
      const dir = await tempDir();
      try {
        await whisperXJob(null, config, dir, workerPath, signal, update);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  handle("realign", (input) => {
    const p = project(input.project),
      ids = z.array(z.string()).min(1).parse(input.ids);
    if (!p.media) throw Error("Open a video first");
    trustedFile(p.media.path);
    const originals = p.captions.filter(
      (c) => ids.includes(c.id) && c.source.trim(),
    );
    if (!originals.length) throw Error("Select captions with source text");
    const config = { ...settings };
    return jobs.start("Alignment", async (signal, update) => {
      const dir = await tempDir();
      try {
        const { captions, speechRun } = await whisperXJob(
          p,
          config,
          dir,
          workerPath,
          signal,
          update,
          originals,
        );
        signal.throwIfAborted();
        emit({
          type: "aligned",
          speechRun,
          projectId: p.id,
          language: p.language,
          originals,
          captions,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  handle("transcribe", (input) => {
    const p = project("project" in input ? input.project : input);
    const mode =
      "project" in input ? z.enum(["replace", "add"]).parse(input.mode) : "add";
    if (!p.media) throw Error("Open a video first");
    trustedFile(p.media.path);
    if (settings.speechEngine === "whisperx") {
      const config = { ...settings };
      return jobs.start("Transcription", async (signal, update) => {
        const dir = await tempDir();
        try {
          const { captions, speechRun } = await whisperXJob(
            p,
            config,
            dir,
            workerPath,
            signal,
            update,
          );
          signal.throwIfAborted();
          emit({
            type: "captions",
            projectId: p.id,
            captions,
            mode,
            originals: p.captions,
            language: p.language,
            speechRun,
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
    if (!settings.modelPath)
      throw Error("Select a whisper.cpp model in Settings");
    const config = { ...settings };
    const preset = dtwPreset(config.modelPath);
    return jobs.start("Transcription", async (signal, update) => {
      const dir = await tempDir();
      try {
        const wav = path.join(dir, "speech.wav"),
          out = path.join(dir, "captions");
        await run(
          config.ffmpeg,
          [
            "-y",
            "-i",
            p.media!.path,
            "-vn",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            "-progress",
            "pipe:2",
            wav,
          ],
          signal,
          progress(p.media!.duration, (n, m) => update(n * 0.15, m)),
        );
        await run(
          config.whisper,
          [
            "-m",
            config.modelPath,
            "-f",
            wav,
            "-l",
            p.language || "auto",
            "-dtw",
            preset,
            "-ojf",
            "-of",
            out,
            "-pp",
          ],
          signal,
          (text) => {
            const m = text.match(/progress\s*=\s*(\d+)%/);
            if (m)
              update(
                15 + +m[1] * 0.8,
                "Recognizing and aligning speech locally",
              );
          },
        );
        update(96, "Building captions from aligned tokens");
        const captions = captionsFromWhisperJson(
          JSON.parse(await readFile(out + ".json", "utf8")),
          p.media!.duration,
        );
        signal.throwIfAborted();
        emit({
          type: "captions",
          projectId: p.id,
          captions,
          mode,
          originals: p.captions,
          language: p.language,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  handle("translate", (input) => {
    const p = project(input.project),
      requestId = z.string().uuid().parse(input.requestId);
    const options = TranslationOptionsSchema.parse(input.options),
      config = { ...settings };
    validateTranslationEndpoint(config);
    return jobs.start("Translation", (signal, update) =>
      translateProject(p, requestId, options, config, signal, update, emit),
    );
  });
  handle("compatible", (input) => {
    const p = project(input);
    if (!p.media) throw Error("Open a video first");
    trustedFile(p.media.path);
    const config = { ...settings };
    return jobs.start("Playback copy", async (signal, update) => {
      const dir = await tempDir(),
        previewPath = path.join(dir, "preview.mp4");
      try {
        await run(
          config.ffmpeg,
          [
            "-y",
            "-i",
            p.media!.path,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-r",
            String(p.media!.fps),
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            "-progress",
            "pipe:2",
            previewPath,
          ],
          signal,
          progress(p.media!.duration, update),
        );
        signal.throwIfAborted();
        registerMedia(previewPath);
        emit({
          type: "media",
          projectId: p.id,
          media: { ...p.media!, previewPath },
        });
      } catch (e) {
        await rm(dir, { recursive: true, force: true });
        throw e;
      }
    });
  });
  handle("cancel", (id) => jobs.cancel(id));
  handle("export", async (input) => {
    const p = project(input.project);
    const r = await dialog.showSaveDialog(window, {
      defaultPath: p.name + "." + input.track + ".srt",
      filters: [{ name: "SubRip subtitles", extensions: ["srt"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await writeFile(r.filePath, "\uFEFF" + srt(p, input.track), "utf8");
    return r.filePath;
  });
}
app.whenReady().then(async () => {
  app.setAppUserModelId("studio.raccoon.desktop");
  if (!app.commandLine.hasSwitch("user-data-dir")) {
    await migrateProfile(
      path.join(app.getPath("appData"), "caption-studio"),
      data(),
    );
  }
  await mkdir(data(), { recursive: true });
  protocol.handle("media", async (request) => {
    const file = allowed.get(new URL(request.url).pathname.slice(1));
    if (!file) return new Response("Forbidden", { status: 403 });
    try {
      const info = await stat(file),
        range = request.headers.get("range");
      let start = 0,
        end = info.size - 1,
        status = 200;
      if (range) {
        const m = range.match(/^bytes=(\d+)-(\d*)$/);
        if (!m) return new Response(null, { status: 416 });
        start = +m[1];
        end = m[2] ? Math.min(+m[2], end) : end;
        status = 206;
        if (start > end)
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${info.size}` },
          });
      }
      const ext = path.extname(file).toLowerCase();
      const mime: Record<string, string> = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
      };
      const headers: Record<string, string> = {
        "Content-Type": mime[ext] || "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      };
      if (status === 206)
        headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
      return new Response(
        Readable.toWeb(createReadStream(file, { start, end })) as any,
        { status, headers },
      );
    } catch {
      return new Response("Media missing. Relink using Open video.", {
        status: 404,
      });
    }
  });
  await setup();
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: "#101418",
    title: "Raccoon Studio",
    icon: app.isPackaged
      ? path.join(process.resourcesPath, "icons", "Raccoon.ico")
      : path.join(__dirname, "Raccoon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("close", (event) => {
    if (!canClose) {
      event.preventDefault();
      emit({ type: "closing" });
    }
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  await window.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", async () => {
  await jobs.cancelAllAndWait();
  app.quit();
});

import type { Project, Caption, SpeechRun } from "./model";
import type { SavedWaveform } from "./waveform";
import type { TranslationOptions, TranslationBatchEvent } from "./translation";
import type { DownloadQuality, VideoPreview } from "./download";
import type { GlossaryFile, GlossaryScope } from "./glossary";
export type Settings = {
  ffmpeg: string;
  ffprobe: string;
  ytdlp: string;
  whisper: string;
  modelPath: string;
  speechEngine: "whisperx" | "whispercpp";
  whisperxPython: string;
  whisperxModel: string;
  whisperxDevice: "cpu" | "cuda";
  whisperxCache: string;
  whisperxOffline: boolean;
  endpoint: string;
  model: string;
  apiKey: string;
};
export type Job = {
  id: string;
  kind: string;
  state: "running" | "done" | "failed" | "cancelled";
  progress: number;
  message: string;
  cancellable?: boolean;
};
export type Event =
  | TranslationBatchEvent
  | { type: "speechInstalled"; python: string }
  | { type: "closing" }
  | { type: "job"; job: Job }
  | {
      type: "wave";
      projectId: string;
      requestId: string;
      peaks: number[];
      waveform: SavedWaveform;
      reused: boolean;
    }
  | { type: "media"; projectId: string; media: NonNullable<Project["media"]> }
  | {
      type: "captions";
      projectId: string;
      captions: Caption[];
      mode?: "replace" | "add";
      originals?: Caption[];
      speechRun?: SpeechRun;
      language?: string;
    }
  | {
      type: "aligned";
      speechRun?: SpeechRun;
      projectId: string;
      language: string;
      originals: Caption[];
      captions: Caption[];
    }
  | {
      type: "translation";
      projectId: string;
      id: string;
      original: string;
      originalTarget: string;
      targetLanguage: string;
      guidanceKey?: string;
      text: string;
      error?: string;
    };
export type Requests = {
  clipboardRead: { input: void; output: string };
  clipboardWrite: { input: string; output: void };
  closed: { input: void; output: void };
  settings: { input: void; output: Settings };
  configure: { input: Settings; output: void };
  glossaryImport: { input: void; output: GlossaryFile | null };
  glossaryExport: { input: GlossaryFile; output: string | null };
  glossaryLoadGlobal: { input: GlossaryScope; output: GlossaryFile | null };
  glossarySaveGlobal: { input: GlossaryFile; output: number };
  pick: { input: "media" | "model" | "exe"; output: string | null };
  open: { input: void; output: { project: Project; path: string } | null };
  save: {
    input: { project: Project; path?: string; autosave?: boolean };
    output: string | null;
  };
  recover: { input: void; output: Project | null };
  media: { input: { projectId: string; path: string }; output: string };
  compatible: { input: Project; output: string };
  wave: {
    input: {
      projectId: string;
      requestId: string;
      path: string;
      duration: number;
      cached?: SavedWaveform;
    };
    output: string;
  };
  preview: {
    input: string;
    output: VideoPreview;
  };
  download: {
    input: { url: string; projectId: string; quality?: DownloadQuality };
    output: string;
  };
  transcribe: {
    input: Project | { project: Project; mode: "replace" | "add" };
    output: string;
  };
  realign: { input: { project: Project; ids: string[] }; output: string };
  checkSpeech: { input: void; output: string };
  installSpeech: { input: void; output: string };
  translate: {
    input: { project: Project; requestId: string; options: TranslationOptions };
    output: string;
  };
  cancel: { input: string; output: void };
  export: {
    input: { project: Project; track: "source" | "target" };
    output: string | null;
  };
  url: { input: string; output: string };
};
export interface Bridge {
  call<K extends keyof Requests>(
    name: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]>;
  onEvent(fn: (event: Event) => void): () => void;
}

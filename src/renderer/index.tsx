import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  blank,
  sourceEdit,
  timing,
  split,
  merge,
  translated,
  stamp,
  type Project,
  type Caption,
} from "../shared/model";
import type { Bridge, Job, Settings } from "../shared/ipc";
import "./style.css";
import { overlappingCaptions, pasteCaptions } from "../shared/editing";
import { applyRealignment, applyTranscription } from "../shared/whisperx";
import { waveformMatchesMedia } from "../shared/waveform";
import { changeLanguages } from "../shared/context";
import { ContextPanel } from "./ContextPanel";
import type { DownloadQuality, VideoPreview } from "../shared/download";
import {
  applyTranslationBatch,
  readabilityIssues,
  type TranslationOptions,
} from "../shared/translation";
declare global {
  interface Window {
    studio: Bridge;
  }
}
const api = window.studio;
const zoomSteps = [1, 2, 4, 8, 16, 32, 64, 128, 256];
function rulerStep(seconds: number) {
  const raw = Math.max(0.001, seconds);
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((n) => n * power).find((n) => n >= raw)!;
}
function rulerLabel(seconds: number, step: number, duration: number) {
  const value = stamp(seconds);
  if (step < 1) return value.slice(3).replace(",", ".");
  return duration >= 3600 ? value.slice(0, 8) : value.slice(3, 8);
}
function App() {
  const [p, setP] = useState<Project>(blank),
    [file, setFile] = useState<string>(),
    [selected, setSelected] = useState(""),
    [selection, setSelection] = useState<string[]>([]),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [url, setUrl] = useState(""),
    [peaks, setPeaks] = useState<number[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("Ready when you are"),
    [panel, setPanel] = useState<"none" | "download" | "settings" | "context">(
      "none",
    ),
    [translationMode, setTranslationMode] =
      useState<TranslationOptions["mode"]>("needed"),
    [checkMeaning, setCheckMeaning] = useState(true),
    [settings, setSettings] = useState<Settings>(),
    [videoUrl, setVideoUrl] = useState(""),
    [metadata, setMetadata] = useState<VideoPreview>(),
    [downloadQuality, setDownloadQuality] = useState<DownloadQuality>("best"),
    [previewing, setPreviewing] = useState(false),
    [zoom, setZoom] = useState(1),
    [filter, setFilter] = useState("all"),
    [transcribeMode, setTranscribeMode] = useState<"replace" | "add">(
      "replace",
    ),
    [historyVersion, setHistoryVersion] = useState(0),
    [saved, setSaved] = useState(""),
    [recovery, setRecovery] = useState<Project | null>(null),
    [initialized, setInitialized] = useState(false);
  const current = useRef(p),
    video = useRef<HTMLVideoElement>(null),
    past = useRef<Project[]>([]),
    future = useRef<Project[]>([]),
    canvas = useRef<HTMLCanvasElement>(null),
    timelineScroll = useRef<HTMLDivElement>(null),
    latestWave = useRef(""),
    latestTranslation = useRef(""),
    previewRevision = useRef(0),
    pendingRecovery = useRef<Project | null>(null),
    drag = useRef<{
      id: string;
      mode: string;
      x: number;
      start: number;
      end: number;
      before: Project;
      ids: string[];
    } | null>(null),
    switching = useRef(false);
  current.current = p;
  pendingRecovery.current = recovery;
  useEffect(() => {
    setSelection((ids) => {
      const remaining = ids.filter((id) => p.captions.some((c) => c.id === id));
      return remaining.length === ids.length ? ids : remaining;
    });
  }, [p.captions]);
  function select(id: string) {
    setSelected(id);
    setSelection(id ? [id] : []);
  }
  function choose(
    id: string,
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) {
    if (e.shiftKey && selected) {
      const a = sorted.findIndex((c) => c.id === selected),
        b = sorted.findIndex((c) => c.id === id);
      setSelection(
        sorted.slice(Math.min(a, b), Math.max(a, b) + 1).map((c) => c.id),
      );
    } else if (e.ctrlKey || e.metaKey) {
      setSelection((ids) =>
        ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
      );
      setSelected(id);
    } else select(id);
  }
  function deleteSelected() {
    commit((prev) => ({
      ...prev,
      captions: prev.captions.filter((c) => !selection.includes(c.id)),
    }));
    select("");
  }
  async function copySelected(cut = false) {
    const project = current.current;
    const captions = project.captions.filter((c) => selection.includes(c.id));
    if (!captions.length) return;
    await api.call(
      "clipboardWrite",
      JSON.stringify({
        format: "raccoon-studio/1",
        targetLanguage: project.targetLanguage,
        captions,
      }),
    );
    if (cut && current.current === project) deleteSelected();
    setNotice(`${captions.length} captions ${cut ? "cut" : "copied"}`);
  }
  async function pasteSelected() {
    const project = current.current,
      position = time;
    const text = await api.call("clipboardRead", undefined);
    if (current.current !== project) return;
    let captions: Caption[];
    try {
      captions = pasteCaptions(
        text,
        position,
        duration,
        project.targetLanguage,
      );
    } catch (e) {
      throw Error(
        e instanceof Error && e.message.includes("do not fit")
          ? e.message
          : "Copy caption blocks in Raccoon Studio before pasting.",
      );
    }
    commit((prev) => ({ ...prev, captions: [...prev.captions, ...captions] }));
    setSelected(captions[0].id);
    setSelection(captions.map((c) => c.id));
    setNotice(`Pasted ${captions.length} captions at the playhead`);
  }
  const duration = p.media?.duration || 30,
    tickStep = rulerStep(duration / zoom / 8),
    tickCount = Math.floor(duration / tickStep) + 1,
    active = p.captions.find((c) => c.id === selected),
    sorted = [...p.captions].sort((a, b) => a.start - b.start),
    overlaps = overlappingCaptions(p.captions),
    running = jobs.filter((j) => j.state === "running"),
    busy = running.some((j) =>
      [
        "Transcription",
        "Alignment",
        "Translation",
        "Download video",
        "Inspect video",
        "Playback copy",
      ].includes(j.kind),
    );
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }
  async function attempt<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (e) {
      fail(e);
    }
  }
  function commit(next: Project | ((p: Project) => Project), record = true) {
    const prev = current.current,
      n = typeof next === "function" ? next(prev) : next;
    if (record) {
      past.current.push(prev);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
    }
    current.current = n;
    setSaved("Unsaved changes");
    setP(n);
    setHistoryVersion((v) => v + 1);
  }
  function undo() {
    const prev = past.current.pop();
    if (prev) {
      future.current.push(current.current);
      current.current = prev;
      setP(prev);
      setHistoryVersion((v) => v + 1);
    }
  }
  function redo() {
    const next = future.current.pop();
    if (next) {
      past.current.push(current.current);
      current.current = next;
      setP(next);
      setHistoryVersion((v) => v + 1);
    }
  }
  function edit(id: string, fn: (c: Caption) => Caption) {
    commit((prev) => ({
      ...prev,
      captions: prev.captions.map((c) => (c.id === id ? fn(c) : c)),
    }));
  }
  function seek(t: number) {
    if (video.current) {
      video.current.currentTime = Math.max(0, Math.min(duration, t));
      setTime(video.current.currentTime);
    }
  }
  function toggle() {
    if (!video.current || !videoUrl) return;
    if (video.current.paused) void video.current.play().catch(fail);
    else video.current.pause();
  }
  function step(n: number) {
    video.current?.pause();
    seek(time + n / (p.media?.fps || 30));
  }
  function add() {
    const start = Math.min(time, Math.max(0, duration - 0.1)),
      c: Caption = {
        id: crypto.randomUUID(),
        start,
        end: Math.min(duration, start + 2),
        source: "",
        target: "",
        status: "empty",
      };
    commit((prev) => ({ ...prev, captions: [...prev.captions, c] }));
    select(c.id);
  }
  function splitSelected() {
    if (!active) return;
    try {
      const pair = split(active, time, crypto.randomUUID());
      commit((prev) => ({
        ...prev,
        captions: prev.captions.flatMap((c) =>
          c.id === active.id ? pair : [c],
        ),
      }));
    } catch (e) {
      fail(e);
    }
  }
  function mergeSelected() {
    if (!active) return;
    const next = sorted[sorted.findIndex((c) => c.id === selected) + 1];
    if (!next) return;
    commit((prev) => ({
      ...prev,
      captions: prev.captions
        .filter((c) => c.id !== next.id)
        .map((c) => (c.id === active.id ? merge(c, next) : c)),
    }));
  }
  async function prepareMedia(next: Project) {
    const media = next.media;
    if (!media) return;
    const requestId = crypto.randomUUID();
    latestWave.current = requestId;
    const url = await api.call("url", media.previewPath || media.path);
    if (
      latestWave.current !== requestId ||
      current.current.id !== next.id ||
      current.current.media?.path !== media.path
    )
      return;
    setVideoUrl(url);
    await api.call("wave", {
      projectId: next.id,
      requestId,
      path: media.path,
      duration: media.duration,
      cached: next.waveform,
    });
  }
  async function load(next: Project, path?: string) {
    const sourceLanguage = ["zh", "Chinese"].includes(next.language)
      ? "zh"
      : "en";
    const targetLanguage = ["en", "English"].includes(next.targetLanguage)
      ? "English"
      : "Chinese";
    next = {
      ...next,
      language: sourceLanguage,
      targetLanguage,
      captions: next.captions.map((c) =>
        targetLanguage !== next.targetLanguage && c.target
          ? { ...c, status: "stale" }
          : c,
      ),
    };
    setRecovery(null);
    video.current?.pause();
    if (video.current) video.current.currentTime = 0;
    switching.current = true;
    latestWave.current = "";
    latestTranslation.current = "";
    current.current = next;
    setP(next);
    setFile(path);
    past.current = [];
    future.current = [];
    select(next.captions[0]?.id || "");
    setPeaks([]);
    setTime(0);
    setVideoUrl("");
    setSaved("");
    if (next.media) {
      await attempt(() => prepareMedia(next));
    }
    switching.current = false;
  }
  async function openVideo() {
    const path = await api.call("pick", "media");
    if (path) {
      await api.call("save", { project: current.current, autosave: true });
      const next = blank();
      await load(next);
      await api.call("media", { projectId: next.id, path });
    }
  }
  async function save(as = false) {
    const path = await api.call("save", {
      project: current.current,
      path: as ? undefined : file,
    });
    if (path) {
      setFile(path);
      setNotice("Project saved");
    }
  }
  useEffect(() => {
    void attempt(async () => {
      setSettings(await api.call("settings", undefined));
      setRecovery(await api.call("recover", undefined));
      setInitialized(true);
    });
    return api.onEvent((e) => {
      if (e.type === "speechInstalled") {
        setSettings((prev) =>
          prev
            ? {
                ...prev,
                whisperxPython: e.python,
                speechEngine: "whisperx",
                whisperxDevice: "cpu",
              }
            : prev,
        );
        setNotice(
          "WhisperX installed and selected. Models download on first transcription.",
        );
        return;
      }
      if (e.type === "closing") {
        void attempt(async () => {
          if (
            !pendingRecovery.current ||
            current.current.media ||
            current.current.captions.length
          )
            await api.call("save", {
              project: current.current,
              autosave: true,
            });
          await api.call("closed", undefined);
        });
        return;
      }
      if (e.type === "job") {
        setJobs((prev) =>
          [...prev.filter((j) => j.id !== e.job.id), e.job].slice(-30),
        );
        return;
      }
      if (e.projectId !== current.current.id) return;
      if (e.type === "translationBatch") {
        if (e.requestId !== latestTranslation.current) return;
        const result = applyTranslationBatch(current.current, e);
        if (result.applied) commit(result.project);
        setNotice(
          `${result.applied} translation drafts applied${result.skipped ? ` · ${result.skipped} skipped because captions or guidance changed` : ""}`,
        );
        return;
      }
      if (e.type === "wave") {
        if (
          e.requestId !== latestWave.current ||
          !waveformMatchesMedia(e.waveform, current.current.media)
        )
          return;
        setPeaks(e.peaks);
        if (!e.reused) {
          const attach = (snapshot: Project): Project =>
            snapshot.id === e.projectId &&
            waveformMatchesMedia(e.waveform, snapshot.media)
              ? { ...snapshot, waveform: e.waveform }
              : snapshot;
          // Derived media data is independent of undoable caption edits.
          past.current = past.current.map(attach);
          future.current = future.current.map(attach);
          if (drag.current) drag.current.before = attach(drag.current.before);
          const next = attach(current.current);
          current.current = next;
          setP(next);
          setSaved("Unsaved changes");
        }
        return;
      }
      if (e.type === "aligned" && e.language === current.current.language) {
        commit((prev) => ({
          ...prev,
          captions: applyRealignment(prev.captions, e.originals, e.captions),
          speechRuns: e.speechRun
            ? [...(prev.speechRuns || []), e.speechRun]
            : prev.speechRuns,
        }));
        setNotice(
          e.speechRun?.importError
            ? `Alignment output retained; could not update captions: ${e.speechRun.importError}`
            : "Alignment finished; edited captions were preserved. Check any sync warnings.",
        );
      }
      if (e.type === "media") {
        const next = {
          ...current.current,
          name:
            e.media.path
              .split(/[\\/]/)
              .pop()
              ?.replace(/\.[^.]+$/, "") || "Video",
          media: e.media,
          waveform: waveformMatchesMedia(current.current.waveform, e.media)
            ? current.current.waveform
            : undefined,
        };
        latestWave.current = "";
        if (!waveformMatchesMedia(current.current.waveform, e.media))
          setPeaks([]);
        commit(next);
        void attempt(() => prepareMedia(next));
      }
      if (e.type === "captions") {
        if (e.language && e.language !== current.current.language) return;
        const result = applyTranscription(
          current.current,
          e.captions,
          e.mode || "add",
          e.originals || [],
          e.speechRun,
        );
        commit(result.project);
        setNotice(
          e.speechRun?.importError
            ? `WhisperX output retained; could not import captions: ${e.speechRun.importError}`
            : result.blocked
              ? "Captions changed during transcription; your edits were preserved. New results are retained in the project. Undo edits or transcribe again to replace."
              : `${e.captions.length} captions ${e.mode === "replace" ? "replaced (Undo available)" : "added"}`,
        );
      }
      if (
        e.type === "translation" &&
        e.targetLanguage === current.current.targetLanguage
      )
        commit((prev) => ({
          ...prev,
          captions: prev.captions.map((c) =>
            c.id === e.id
              ? translated(c, e.original, e.text, e.error, e.originalTarget)
              : c,
          ),
        }));
    });
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (switching.current || !initialized || recovery) return;
      void api
        .call("save", { project: p, autosave: true })
        .then(() => setSaved("Autosaved"))
        .catch(fail);
    }, 700);
    return () => clearTimeout(timer);
  }, [p, initialized, recovery]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const input = (e.target as HTMLElement).matches("input,textarea,select");
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        void attempt(() => save(e.shiftKey));
        return;
      }
      if (input) return;
      const editing = (e.target as HTMLElement).closest(
        ".timeline,.caption-scroll",
      );
      if (
        editing &&
        (e.ctrlKey || e.metaKey) &&
        ["a", "c", "x", "v"].includes(e.key.toLowerCase())
      ) {
        e.preventDefault();
        const key = e.key.toLowerCase();
        if (key === "a") {
          setSelection(sorted.map((c) => c.id));
          setSelected(sorted[0]?.id || "");
        } else if (key === "v") void attempt(pasteSelected);
        else void attempt(() => copySelected(key === "x"));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === "y") {
        e.preventDefault();
        redo();
      } else if (e.code === "Space") {
        e.preventDefault();
        toggle();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key.toLowerCase() === "n") add();
      else if (e.key.toLowerCase() === "s") splitSelected();
      else if (e.key.toLowerCase() === "m") mergeSelected();
      else if (e.key === "Delete" && selection.length) {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = sorted.findIndex((c) => c.id === selected),
          c =
            sorted[
              Math.max(
                0,
                Math.min(
                  sorted.length - 1,
                  i + (e.key === "ArrowDown" ? 1 : -1),
                ),
              )
            ];
        if (c) {
          select(c.id);
          seek(c.start);
          document.getElementById(c.id)?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    const el = canvas.current;
    const scroll = timelineScroll.current;
    if (!el || !scroll) return;
    const amplitude = peaks.reduce((max, peak) => Math.max(max, peak), 0) || 1;
    const draw = () => {
      const w = scroll.clientWidth,
        h = el.clientHeight,
        scale = Math.min(devicePixelRatio, 2),
        timelineWidth = scroll.scrollWidth;
      el.style.width = `${w}px`;
      el.width = Math.round(w * scale);
      el.height = Math.round(h * scale);
      const ctx = el.getContext("2d")!;
      ctx.scale(scale, scale);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#4d9f93";
      for (let x = 0; x < w; x += 2) {
        const a = Math.floor(
            ((scroll.scrollLeft + x) / timelineWidth) * peaks.length,
          ),
          b = Math.max(
            a + 1,
            Math.floor(
              ((scroll.scrollLeft + x + 2) / timelineWidth) * peaks.length,
            ),
          );
        let peak = 0;
        for (let i = a; i < b; i++) peak = Math.max(peak, peaks[i] || 0);
        const size = (peak / amplitude) * (h - 8);
        ctx.fillRect(x, (h - size) / 2, 1.5, Math.max(1, size));
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(scroll);
    scroll.addEventListener("scroll", draw, { passive: true });
    return () => {
      observer.disconnect();
      scroll.removeEventListener("scroll", draw);
    };
  }, [peaks, zoom]);
  useEffect(() => {
    const scroll = timelineScroll.current;
    if (!scroll) return;
    scroll.scrollLeft = Math.max(
      0,
      (time / duration) * scroll.scrollWidth - scroll.clientWidth / 2,
    );
  }, [zoom]);
  function pointerDown(e: React.PointerEvent, id: string, mode: string) {
    e.preventDefault();
    e.stopPropagation();
    const c = p.captions.find((c) => c.id === id)!;
    (e.currentTarget.closest(".clip") as HTMLElement)?.focus();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      choose(id, e);
      return;
    }
    if (!selection.includes(id)) select(id);
    drag.current = {
      id,
      mode,
      x: e.clientX,
      start: c.start,
      end: c.end,
      before: current.current,
      ids: selection.includes(id) ? selection : [id],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function pointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const width = e.currentTarget
        .closest(".timeline-inner")!
        .getBoundingClientRect().width,
      delta = ((e.clientX - d.x) / width) * duration;
    let start = d.start,
      end = d.end;
    if (d.mode === "move") {
      const group = d.before.captions.filter((c) => d.ids.includes(c.id));
      const shift = Math.max(
        -Math.min(...group.map((c) => c.start)),
        Math.min(duration - Math.max(...group.map((c) => c.end)), delta),
      );
      start = d.start + shift;
      end = start + d.end - d.start;
    } else if (d.mode === "start")
      start = Math.max(0, Math.min(end - 0.04, start + delta));
    else end = Math.min(duration, Math.max(start + 0.04, end + delta));
    commit(
      (prev) => ({
        ...prev,
        captions: prev.captions.map((c) =>
          d.mode === "move" && d.ids.includes(c.id)
            ? (() => {
                const original = d.before.captions.find((x) => x.id === c.id)!;
                return timing(
                  c,
                  original.start + start - d.start,
                  original.end + start - d.start,
                  duration,
                );
              })()
            : c.id === d.id
              ? timing(c, start, end, duration)
              : c,
        ),
      }),
      false,
    );
  }
  function pointerUp() {
    const d = drag.current;
    if (d) {
      if (current.current !== d.before) {
        past.current.push(d.before);
        future.current = [];
      }
      drag.current = null;
      setHistoryVersion((v) => v + 1);
    }
  }
  const shown = sorted.filter(
      (c) => filter === "all" || c.status !== "reviewed",
    ),
    reviewed = p.captions.filter((c) => c.status === "reviewed").length,
    currentCaption = sorted.find((c) => time >= c.start && time < c.end);
  return (
    <div className="app">
      <header>
        <div className="brand">
          <img className="logo" src="./Raccoon.ico" alt="" />
          <div>
            Raccoon Studio<small>LOCAL-FIRST SUBTITLE WORKSPACE</small>
          </div>
        </div>
        <div className="project-title">
          {p.name}
          <span>{saved || "Unsaved changes"}</span>
        </div>
        <button
          onClick={() => setPanel(panel === "settings" ? "none" : "settings")}
        >
          ⚙ Settings
        </button>
        <button onClick={() => void attempt(() => save())}>
          Save project <kbd>Ctrl S</kbd>
        </button>
        <button
          className="primary"
          disabled={!p.captions.length}
          onClick={() =>
            void attempt(async () => {
              const source = await api.call("export", {
                project: p,
                track: "source",
              });
              if (source) {
                await api.call("export", { project: p, track: "target" });
                setNotice("Export finished");
              }
            })
          }
        >
          Export SRT ↗
        </button>
      </header>
      <nav>
        <div className="workflow">
          <span className="step active">
            1 <b>Import</b>
          </span>
          <i>→</i>
          <span className={p.media ? "step active" : "step"}>
            2 <b>Transcribe</b>
          </span>
          <i>→</i>
          <span className={p.captions.length ? "step active" : "step"}>
            3 <b>Edit & translate</b>
          </span>
          <i>→</i>
          <span className="step">
            4 <b>Review & export</b>
          </span>
        </div>
        <button disabled={busy} onClick={() => void attempt(openVideo)}>
          ＋ Open video
        </button>
        <button
          disabled={busy}
          onClick={() => setPanel(panel === "download" ? "none" : "download")}
        >
          ↗ Video URL
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void attempt(async () => {
              const r = await api.call("open", undefined);
              if (r) {
                await api.call("save", {
                  project: current.current,
                  autosave: true,
                });
                await load(r.project, r.path);
              }
            })
          }
        >
          Open project
        </button>
      </nav>
      <ContextPanel
        project={p}
        visible={panel === "context"}
        onChange={(next) => commit(next)}
        onError={fail}
        onClose={() => setPanel("none")}
        onCaption={(id) => {
          select(id);
          const caption = current.current.captions.find((c) => c.id === id);
          if (caption) {
            setTime(caption.start);
            if (video.current) video.current.currentTime = caption.start;
          }
        }}
      />
      {recovery && (
        <div className="banner">
          A previous autosave is available.
          <button
            disabled={busy}
            onClick={() => {
              void load(recovery);
              setRecovery(null);
            }}
          >
            Restore session
          </button>
          <button onClick={() => setRecovery(null)}>Dismiss</button>
        </div>
      )}
      {error && (
        <div className="banner error" role="alert">
          {error}
          {error.startsWith("Playback failed") && p.media && (
            <button
              disabled={busy}
              onClick={() =>
                void attempt(async () => {
                  await api.call("compatible", p);
                  setError("");
                })
              }
            >
              Create compatible preview
            </button>
          )}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {panel === "download" && (
        <section className="panel">
          <div>
            <h3>Import from a video URL</h3>
            <p>Preview a single video, then choose where to save it.</p>
          </div>
          <input
            aria-label="Video URL"
            placeholder="https://…"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setMetadata(undefined);
              previewRevision.current++;
              setPreviewing(false);
              setDownloadQuality("best");
            }}
          />
          <button
            disabled={previewing || !url.trim()}
            onClick={() =>
              void attempt(async () => {
                const revision = ++previewRevision.current;
                setPreviewing(true);
                setMetadata(undefined);
                try {
                  const result = await api.call("preview", url);
                  if (revision === previewRevision.current) {
                    setMetadata(result);
                    setDownloadQuality("best");
                  }
                } finally {
                  if (revision === previewRevision.current)
                    setPreviewing(false);
                }
              })
            }
          >
            Preview
          </button>
          {metadata && (
            <>
              <div className="metadata">
                <b>{metadata.title}</b>
                <small>
                  {metadata.uploader} · {stamp(metadata.duration)}
                </small>
              </div>
              <label className="download-quality">
                Video quality
                <select
                  aria-label="Video quality"
                  value={downloadQuality}
                  onChange={(e) =>
                    setDownloadQuality(
                      e.target.value === "best"
                        ? "best"
                        : Number(e.target.value),
                    )
                  }
                  disabled={busy}
                >
                  <option value="best">Best available</option>
                  {metadata.qualities.map((height) => (
                    <option key={height} value={height}>
                      {height}p or lower
                    </option>
                  ))}
                </select>
                <small>
                  {metadata.qualities.length
                    ? "Includes audio when available"
                    : "The site did not report resolution choices"}
                </small>
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void attempt(async () => {
                    const previous = current.current,
                      previousFile = file;
                    await api.call("save", {
                      project: previous,
                      autosave: true,
                    });
                    const next = blank();
                    await load(next);
                    const job = await api.call("download", {
                      url,
                      projectId: next.id,
                      quality: downloadQuality,
                    });
                    if (!job) await load(previous, previousFile);
                    setPanel("none");
                  })
                }
              >
                Download & import
              </button>
            </>
          )}
        </section>
      )}
      {panel === "settings" && settings && (
        <section className="settings panel">
          <div>
            <h3>Tools & translation</h3>
            <p>
              Local tools run in the background. API keys are encrypted with
              Windows when saved.
            </p>
          </div>
          <label>
            Speech engine
            <select
              value={settings.speechEngine}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  speechEngine: e.target.value as Settings["speechEngine"],
                })
              }
            >
              <option value="whisperx">WhisperX (forced alignment)</option>
              <option value="whispercpp">whisper.cpp (legacy fallback)</option>
            </select>
          </label>
          <label>
            WhisperX device
            <select
              value={settings.whisperxDevice}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  whisperxDevice: e.target.value as "cpu" | "cuda",
                })
              }
            >
              <option value="cpu">CPU</option>
              <option value="cuda">NVIDIA GPU (CUDA)</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.whisperxOffline}
              onChange={(e) =>
                setSettings({ ...settings, whisperxOffline: e.target.checked })
              }
            />
            Use cached models only (offline)
          </label>
          {(
            [
              "ffmpeg",
              "ffprobe",
              "ytdlp",
              "whisper",
              "modelPath",
              "whisperxPython",
              "whisperxModel",
              "whisperxCache",
              "endpoint",
              "model",
              "apiKey",
            ] as const
          )
            .filter(
              (key) =>
                settings.speechEngine === "whispercpp" ||
                !["whisper", "modelPath"].includes(key),
            )
            .map((key) => (
              <label key={key}>
                {
                  {
                    ffmpeg: "FFmpeg executable",
                    ffprobe: "FFprobe executable",
                    ytdlp: "yt-dlp executable",
                    whisper: "whisper.cpp executable",
                    modelPath: "Whisper GGML model",
                    whisperxPython: "WhisperX Python executable",
                    whisperxModel:
                      "WhisperX model (e.g. medium, large-v3, or local directory)",
                    whisperxCache: "WhisperX model cache folder",
                    endpoint: "API base URL (ending /v1)",
                    model: "Translation model ID",
                    apiKey: "API key",
                  }[key]
                }
                <div className="field">
                  <input
                    type={key === "apiKey" ? "password" : "text"}
                    value={settings[key]}
                    onChange={(e) =>
                      setSettings({ ...settings, [key]: e.target.value })
                    }
                  />
                  {[
                    "ffmpeg",
                    "ffprobe",
                    "ytdlp",
                    "whisper",
                    "whisperxPython",
                    "modelPath",
                  ].includes(key) && (
                    <button
                      aria-label={"Browse " + key}
                      onClick={() =>
                        void attempt(async () => {
                          const path = await api.call(
                            "pick",
                            key === "modelPath" ? "model" : "exe",
                          );
                          if (path) setSettings({ ...settings, [key]: path });
                        })
                      }
                    >
                      …
                    </button>
                  )}
                </div>
              </label>
            ))}
          <p>
            Install WhisperX here without installing Python yourself. CPU setup
            downloads about 600 MB and needs at least 6.5 GB of free disk space
            during installation. First transcription downloads the selected
            model and the language alignment model into the cache. Existing GGML
            files cannot be used by WhisperX.
          </p>
          <button
            disabled={jobs.some(
              (job) =>
                job.kind === "WhisperX installation" && job.state === "running",
            )}
            onClick={() =>
              void attempt(async () => {
                await api.call("installSpeech", undefined);
                setNotice(
                  "Installing WhisperX; see background tasks for progress and cancellation",
                );
              })
            }
          >
            {jobs.some(
              (job) =>
                job.kind === "WhisperX installation" && job.state === "running",
            )
              ? "Installing WhisperX…"
              : "Install WhisperX"}
          </button>
          <button
            onClick={() =>
              void attempt(async () => {
                await api.call("configure", settings);
                await api.call("checkSpeech", undefined);
                setNotice("Checking WhisperX; see background tasks");
              })
            }
          >
            Check WhisperX setup
          </button>
          <button
            className="primary"
            onClick={() =>
              void attempt(async () => {
                await api.call("configure", settings);
                setPanel("none");
                setNotice("Settings saved");
              })
            }
          >
            Save settings
          </button>
        </section>
      )}
      <main>
        <section className="preview">
          <div className="section-head">
            <h2>Video preview</h2>
            <span className="pill">
              {p.media ? `${p.media.fps.toFixed(2)} fps` : "NO MEDIA"}
            </span>
          </div>
          <div className="screen">
            {videoUrl ? (
              <>
                <video
                  ref={video}
                  src={videoUrl}
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onError={() =>
                    setError(
                      "Playback failed. Relink missing media, or create an H.264/AAC preview for an unsupported codec.",
                    )
                  }
                  onClick={toggle}
                />
                <div className="subtitle">
                  {currentCaption?.target.trim()
                    ? currentCaption.target
                    : currentCaption?.source}
                </div>
              </>
            ) : (
              <div className="empty-video">
                <div className="film">▷</div>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void attempt(openVideo)}
                >
                  Open local video
                </button>
              </div>
            )}
          </div>
          <div className="transport">
            <button
              aria-label="Previous frame"
              disabled={!videoUrl}
              onClick={() => step(-1)}
            >
              Ⅰ◁
            </button>
            <button
              className="play"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!videoUrl}
              onClick={toggle}
            >
              {playing ? "Ⅱ" : "▶"}
            </button>
            <button
              aria-label="Next frame"
              disabled={!videoUrl}
              onClick={() => step(1)}
            >
              ▷Ⅰ
            </button>
            <span className="time">
              {stamp(time).replace(",", ".")}{" "}
              <em>/ {stamp(duration).replace(",", ".")}</em>
            </span>
            <select
              aria-label="Playback speed"
              onChange={(e) => {
                if (video.current) video.current.playbackRate = +e.target.value;
              }}
              defaultValue="1"
            >
              <option value="0.5">0.5×</option>
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
            </select>
          </div>
          <input
            className="seek"
            aria-label="Seek video"
            type="range"
            min="0"
            max={duration}
            step="0.001"
            value={time}
            onChange={(e) => seek(+e.target.value)}
          />
          <div className="media-name">
            {p.media?.path.split(/[\\/]/).pop() ||
              "Media stays on your computer"}
            {p.media ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void attempt(async () => {
                    const path = await api.call("pick", "media");
                    if (path) {
                      setError("");
                      setPeaks([]);
                      await api.call("media", { projectId: p.id, path });
                    }
                  })
                }
              >
                Relink video
              </button>
            ) : (
              <span>No upload required</span>
            )}
          </div>
        </section>
        <section className="captions">
          <div className="section-head">
            <h2>
              Captions <span>{p.captions.length}</span>
            </h2>
            <div>
              <select
                aria-label="Caption filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">All captions</option>
                <option value="review">Needs review</option>
              </select>
              {p.captions.length > 0 && (
                <select
                  aria-label="Transcription import mode"
                  value={transcribeMode}
                  disabled={busy}
                  onChange={(e) =>
                    setTranscribeMode(e.target.value as "replace" | "add")
                  }
                >
                  <option value="replace">Replace captions</option>
                  <option value="add">Add captions</option>
                </select>
              )}
              <button
                disabled={!p.media || busy}
                onClick={() =>
                  void attempt(async () => {
                    await api.call("transcribe", {
                      project: p,
                      mode: transcribeMode,
                    });
                  })
                }
              >
                ✧ Transcribe
              </button>
              <button
                disabled={!p.captions.length || busy}
                onClick={() =>
                  void attempt(async () => {
                    const requestId = crypto.randomUUID();
                    latestTranslation.current = requestId;
                    await api.call("translate", {
                      project: p,
                      requestId,
                      options: {
                        mode: translationMode,
                        ids: selection,
                        checkMeaning,
                      },
                    });
                  })
                }
              >
                Translate →
              </button>
            </div>
          </div>
          <div className="translation-tools">
            <button
              onClick={() => setPanel(panel === "context" ? "none" : "context")}
            >
              Translation context
            </button>
            <label>
              Translate{" "}
              <select
                aria-label="Translation scope"
                value={translationMode}
                disabled={busy}
                onChange={(e) =>
                  setTranslationMode(
                    e.target.value as TranslationOptions["mode"],
                  )
                }
              >
                <option value="needed">Empty, stale and failed</option>
                <option value="selected">
                  Selected captions (replace drafts)
                </option>
                <option value="replace">All unreviewed (replace drafts)</option>
              </select>
            </label>
            <label>
              <input
                type="checkbox"
                checked={checkMeaning}
                disabled={busy}
                onChange={(e) => setCheckMeaning(e.target.checked)}
              />{" "}
              Check meaning
            </label>
            <small>Reviewed captions are preserved</small>
          </div>
          <div className="track-head">
            <span>TIME</span>
            <label>
              SOURCE{" "}
              <select
                aria-label="Source language"
                value={p.language}
                disabled={busy}
                onChange={(e) =>
                  commit(changeLanguages(p, e.target.value, p.targetLanguage))
                }
              >
                <option value="en">English</option>
                <option value="zh">Chinese</option>
              </select>
            </label>
            <label>
              TRANSLATION{" "}
              <select
                aria-label="Target language"
                value={p.targetLanguage}
                disabled={busy}
                onChange={(e) =>
                  commit(changeLanguages(p, p.language, e.target.value))
                }
              >
                <option value="English">English</option>
                <option value="Chinese">Chinese</option>
              </select>
            </label>
            <span>REVIEW</span>
          </div>
          <div
            className="caption-scroll"
            tabIndex={0}
            aria-label="Caption list"
          >
            {shown.length ? (
              shown.map((c, i) => (
                <div
                  id={c.id}
                  key={c.id}
                  tabIndex={0}
                  className={
                    "caption-row " +
                    (selection.includes(c.id) ? "selected" : "")
                  }
                  onClick={(e) => {
                    choose(c.id, e);
                    if (
                      !(e.target as HTMLElement).closest(
                        "input,textarea,button",
                      )
                    )
                      e.currentTarget.focus();
                  }}
                >
                  <div className="cue-time">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        choose(c.id, e);
                        seek(c.start);
                      }}
                    >
                      {String(sorted.indexOf(c) + 1).padStart(2, "0")}
                    </button>
                    <input
                      aria-label={"Start " + (i + 1)}
                      type="number"
                      step="0.01"
                      value={Number(c.start.toFixed(3))}
                      onChange={(e) => {
                        try {
                          edit(c.id, (v) =>
                            timing(v, +e.target.value, v.end, duration),
                          );
                        } catch (err) {
                          fail(err);
                        }
                      }}
                    />
                    <input
                      aria-label={"End " + (i + 1)}
                      type="number"
                      step="0.01"
                      value={Number(c.end.toFixed(3))}
                      onChange={(e) => {
                        try {
                          edit(c.id, (v) =>
                            timing(v, v.start, +e.target.value, duration),
                          );
                        } catch (err) {
                          fail(err);
                        }
                      }}
                    />
                    {c.alignment && (
                      <small
                        className={
                          "alignment-state " +
                          (c.alignment.needsReview ? "check" : "aligned")
                        }
                        title={
                          c.alignment.needsReview
                            ? "Source or timing changed, or token alignment is uncertain. Check against audio."
                            : c.alignment.method === "whisperx"
                              ? "Timed with WhisperX forced alignment"
                              : "Timed from Whisper DTW audio-aligned tokens"
                        }
                      >
                        {c.alignment.needsReview
                          ? "Check sync"
                          : "Audio aligned"}
                      </small>
                    )}
                  </div>
                  <textarea
                    aria-label={"Source caption " + (i + 1)}
                    placeholder="Type the spoken words…"
                    value={c.source}
                    onChange={(e) =>
                      edit(c.id, (v) => sourceEdit(v, e.target.value))
                    }
                  />
                  <div className="target-cell">
                    <textarea
                      aria-label={"Translation caption " + (i + 1)}
                      placeholder="Translation appears here…"
                      value={c.target}
                      onChange={(e) =>
                        edit(c.id, (v) => ({
                          ...v,
                          target: e.target.value,
                          status: "draft",
                          error: undefined,
                          translation: { origin: "manual", issues: [] },
                        }))
                      }
                    />
                    {c.error && <small className="failure">{c.error}</small>}
                    {[
                      ...(c.target.trim()
                        ? c.translation?.issues.filter(
                            (issue) => issue.kind !== "readability",
                          ) || []
                        : []),
                      ...(c.target
                        ? readabilityIssues(
                            c.target,
                            c.end - c.start,
                            p.targetLanguage,
                          )
                        : []),
                    ].map((issue, j) => (
                      <small className="translation-issue" key={j}>
                        {issue.kind === "meaning"
                          ? "Check meaning"
                          : "Readability"}
                        : {issue.message}
                      </small>
                    ))}
                  </div>
                  <button
                    className={"review " + c.status}
                    title={
                      c.status === "stale"
                        ? "Source changed — check the translation"
                        : c.status
                    }
                    disabled={!c.target}
                    onClick={() =>
                      edit(c.id, (v) => ({
                        ...v,
                        status: v.status === "reviewed" ? "draft" : "reviewed",
                        error: undefined,
                      }))
                    }
                  >
                    {c.status === "reviewed"
                      ? "✓"
                      : c.status === "stale"
                        ? "↻"
                        : c.status === "failed"
                          ? "!"
                          : "○"}
                    <small>{c.status}</small>
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-captions">
                <span>☷</span>
                <h3>
                  {p.captions.length
                    ? "All captions reviewed"
                    : "Every word has a place"}
                </h3>
                <p>Transcribe your video locally, or add your first caption.</p>
                <button disabled={!p.media} onClick={add}>
                  ＋ Add caption
                </button>
              </div>
            )}
          </div>
          <div className="caption-footer">
            <span>
              {reviewed} / {p.captions.length} reviewed
              {p.captions.some((c) => !c.target.trim()) &&
                ` · ${p.captions.filter((c) => !c.target.trim()).length} untranslated`}
            </span>
            <button disabled={!p.media} onClick={add}>
              ＋ Add caption <kbd>N</kbd>
            </button>
          </div>
        </section>
      </main>
      <section className="timeline" tabIndex={0} aria-label="Caption timeline">
        <div className="section-head">
          <div className="timeline-tools">
            <h2>Timeline</h2>
            <button
              disabled={!past.current.length}
              onClick={undo}
              aria-label="Undo"
              title="Ctrl+Z"
            >
              ↶
            </button>
            <button
              disabled={!future.current.length}
              onClick={redo}
              aria-label="Redo"
              title="Ctrl+Shift+Z"
            >
              ↷
            </button>
            <span className="divider" />
            <button disabled={!active} onClick={splitSelected}>
              Split <kbd>S</kbd>
            </button>
            <button disabled={!active} onClick={mergeSelected}>
              Merge next <kbd>M</kbd>
            </button>
            <button disabled={!selection.length} onClick={deleteSelected}>
              Delete
            </button>
            <button
              disabled={!selection.length}
              title="Copy captions (Ctrl+C)"
              onClick={() => void attempt(() => copySelected())}
            >
              Copy
            </button>
            <button
              disabled={!selection.length}
              title="Cut captions (Ctrl+X)"
              onClick={() => void attempt(() => copySelected(true))}
            >
              Cut
            </button>
            <button
              title="Paste captions at playhead (Ctrl+V)"
              onClick={() => void attempt(pasteSelected)}
            >
              Paste
            </button>
            <button
              disabled={busy || !selection.length}
              onClick={() =>
                void attempt(async () => {
                  await api.call("realign", { project: p, ids: selection });
                })
              }
            >
              Re-align selection
            </button>
            <button
              disabled={busy || !p.captions.length}
              onClick={() =>
                void attempt(async () => {
                  await api.call("realign", {
                    project: p,
                    ids: p.captions.map((c) => c.id),
                  });
                })
              }
            >
              Re-align all
            </button>
            <small aria-live="polite">
              {
                selection.filter((id) => p.captions.some((c) => c.id === id))
                  .length
              }{" "}
              selected
            </small>
          </div>
          <div className="zoom">
            <button
              aria-label="Zoom out timeline"
              disabled={zoom <= 1}
              onClick={() =>
                setZoom(
                  zoomSteps[
                    Math.max(0, zoomSteps.findIndex((n) => n >= zoom) - 1)
                  ],
                )
              }
            >
              −
            </button>
            <input
              aria-label="Timeline zoom"
              type="range"
              min="0"
              max="8"
              step="0.125"
              value={Math.log2(zoom)}
              onChange={(e) => setZoom(2 ** +e.target.value)}
            />
            <button
              aria-label="Zoom in timeline"
              disabled={zoom >= 256}
              onClick={() => setZoom(zoomSteps.find((n) => n > zoom) || 256)}
            >
              ＋
            </button>
            <output aria-label="Zoom level">
              {zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
            </output>
          </div>
        </div>
        <div className="timeline-scroll" ref={timelineScroll}>
          <div
            className="timeline-inner"
            style={{ width: `${zoom * 100}%` }}
            onClick={(e) => {
              if (!drag.current) {
                const r = e.currentTarget.getBoundingClientRect();
                seek(((e.clientX - r.left) / r.width) * duration);
              }
            }}
          >
            <div className="ruler">
              {Array.from({ length: tickCount }, (_, i) => (
                <span
                  key={i}
                  style={{ left: `${((tickStep * i) / duration) * 100}%` }}
                >
                  {rulerLabel(tickStep * i, tickStep, duration)}
                </span>
              ))}
            </div>
            <canvas ref={canvas} />
            {!peaks.length && (
              <div className="wave-label">
                {p.media
                  ? "Waveform will appear after audio analysis"
                  : "Open a video to see its waveform"}
              </div>
            )}
            <div className="lane source-lane">
              {sorted.map((c) => (
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={
                    "Timeline caption " +
                    (c.target.trim() ? c.target : c.source)
                  }
                  key={c.id}
                  aria-pressed={selection.includes(c.id)}
                  title={overlaps.get(c.id)}
                  aria-description={overlaps.get(c.id)}
                  className={
                    "clip " +
                    (c.target.trim() ? "target " + c.status + " " : "") +
                    (selection.includes(c.id) ? "chosen " : "") +
                    (overlaps.has(c.id) ? "overlap" : "")
                  }
                  style={{
                    left: `${(c.start / duration) * 100}%`,
                    width: `${((c.end - c.start) / duration) * 100}%`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      choose(c.id, e);
                      seek(c.start);
                    }
                  }}
                  onPointerDown={(e) => pointerDown(e, c.id, "move")}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={pointerUp}
                >
                  <span
                    className="handle left"
                    onPointerDown={(e) => pointerDown(e, c.id, "start")}
                  />
                  <span>
                    {c.target.trim() ? c.target : c.source || "New caption"}
                  </span>
                  {overlaps.has(c.id) && (
                    <span
                      className="overlap-warning"
                      role="img"
                      aria-label={overlaps.get(c.id)}
                      title={overlaps.get(c.id)}
                    >
                      !
                    </span>
                  )}
                  <span
                    className="handle right"
                    onPointerDown={(e) => pointerDown(e, c.id, "end")}
                  />
                </div>
              ))}
            </div>
            <div
              className="playhead"
              style={{ left: `${(time / duration) * 100}%` }}
            >
              <b>▼</b>
            </div>
          </div>
        </div>
        <div className="timeline-legend">
          <span>
            <i /> Source until translated
          </span>
          <span>
            <i /> Translation when available
          </span>
          <span>
            Drag to move · Drag edges to trim · Click waveform to seek
          </span>
          <span>
            Frame step <kbd>←</kbd> <kbd>→</kbd> · Play <kbd>Space</kbd>
          </span>
        </div>
      </section>
      <section className="tasks">
        <div>
          <b>Background tasks</b>
          <span>
            {running.length ? `${running.length} running` : "All quiet"}
          </span>
        </div>
        <div className="task-list">
          {jobs.length ? (
            [
              ...jobs.filter((j) => j.state === "running"),
              ...jobs
                .filter((j) => j.state !== "running")
                .slice(-3)
                .reverse(),
            ].map((j) => (
              <div className={"task " + j.state} key={j.id}>
                <div>
                  <b>{j.kind}</b>
                  <small title={j.message}>{j.message}</small>
                </div>
                <progress max="100" value={j.progress} />
                <span>
                  {j.state === "running"
                    ? Math.round(j.progress) + "%"
                    : j.state}
                </span>
                {j.state === "running" && (
                  <button
                    disabled={j.cancellable === false}
                    onClick={() => void api.call("cancel", j.id)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))
          ) : (
            <p>
              Downloads, speech recognition and translation run here. Keep
              editing while they work.
            </p>
          )}
        </div>
      </section>
      <footer>
        <span className="status-dot" />
        {notice}
        <span className="footer-right">
          {file
            ? "Project saved on disk"
            : "Project recovery autosaves locally"}{" "}
          · Raccoon Studio 0.1
        </span>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

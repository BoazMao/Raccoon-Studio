import React, {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { timing, sourceEdit, type Caption } from "../shared/model";
import { readabilityIssues } from "../shared/translation";
type Actions = {
  choose: (
    id: string,
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  seek: (time: number) => void;
  edit: (id: string, fn: (caption: Caption) => Caption) => void;
  fail: (error: unknown) => void;
};
const CaptionRow = memo(function CaptionRow({
  c,
  ordinal,
  chosen,
  duration,
  targetLanguage,
  choose,
  seek,
  edit,
  fail,
}: {
  c: Caption;
  ordinal: number;
  chosen: boolean;
  duration: number;
  targetLanguage: string;
} & Actions) {
  return (
    <div
      id={c.id}
      key={c.id}
      tabIndex={0}
      className={"caption-row " + (chosen ? "selected" : "")}
      onClick={(e) => {
        choose(c.id, e);
        if (!(e.target as HTMLElement).closest("input,textarea,button"))
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
          {String(ordinal).padStart(2, "0")}
        </button>
        <input
          aria-label={"Start " + ordinal}
          type="number"
          step="0.01"
          value={Number(c.start.toFixed(3))}
          onChange={(e) => {
            try {
              edit(c.id, (v) => timing(v, +e.target.value, v.end, duration));
            } catch (err) {
              fail(err);
            }
          }}
        />
        <input
          aria-label={"End " + ordinal}
          type="number"
          step="0.01"
          value={Number(c.end.toFixed(3))}
          onChange={(e) => {
            try {
              edit(c.id, (v) => timing(v, v.start, +e.target.value, duration));
            } catch (err) {
              fail(err);
            }
          }}
        />
        {c.recognition?.needsReview && (
          <small
            className="failure"
            title={`ASR average log probability ${c.recognition.avgLogprob.toFixed(2)}. This is not a calibrated accuracy percentage.`}
          >
            Check wording
          </small>
        )}
        {c.recognition?.needsReview && (
          <button
            className="text-button"
            title="Mark source wording checked; retain its original score"
            aria-label={`Mark source wording checked ${ordinal}`}
            onClick={(e) => {
              e.stopPropagation();
              edit(c.id, (v) => ({
                ...v,
                recognition: { ...v.recognition!, needsReview: false },
              }));
            }}
          >
            ✓ Wording
          </button>
        )}
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
            {c.alignment.needsReview ? "Check sync" : "Audio aligned"}
          </small>
        )}
      </div>
      <textarea
        aria-label={"Source caption " + ordinal}
        placeholder="Type the spoken words…"
        value={c.source}
        onChange={(e) => edit(c.id, (v) => sourceEdit(v, e.target.value))}
      />
      <div className="target-cell">
        <textarea
          aria-label={"Translation caption " + ordinal}
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
            ? readabilityIssues(c.target, c.end - c.start, targetLanguage)
            : []),
        ].map((issue, j) => (
          <small className="translation-issue" key={j}>
            {issue.kind === "meaning" ? "Check meaning" : "Readability"}:{" "}
            {issue.message}
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
  );
});
export const CaptionList = memo(
  function CaptionList({
    captions,
    selected,
    selection,
    duration,
    targetLanguage,
    actions,
    empty,
  }: {
    captions: Caption[];
    selected: string;
    selection: string[];
    duration: number;
    targetLanguage: string;
    actions: Actions;
    empty: React.ReactNode;
  }) {
    const scroll = useRef<HTMLDivElement>(null),
      heights = useRef(new Map<string, number>());
    const [viewport, setViewport] = useState({ top: 0, height: 400 }),
      [version, setVersion] = useState(0),
      [focused, setFocused] = useState("");
    const offsets = useMemo(() => {
      const a = [0];
      for (const c of captions)
        a.push(a.at(-1)! + (heights.current.get(c.id) || 110));
      return a;
    }, [captions, version]);
    const chosen = useMemo(() => new Set(selection), [selection]);
    const ordinal = useMemo(
      () => new Map(captions.map((c, i) => [c.id, i + 1])),
      [captions],
    );
    const live = useRef({ captions, offsets });
    live.current = { captions, offsets };
    useLayoutEffect(() => {
      const el = scroll.current!;
      const update = () =>
        setViewport({ top: el.scrollTop, height: el.clientHeight });
      const o = new ResizeObserver(update);
      o.observe(el);
      update();
      return () => o.disconnect();
    }, []);
    useEffect(() => {
      const index = live.current.captions.findIndex((c) => c.id === selected),
        el = scroll.current;
      if (index < 0 || !el) return;
      const a = live.current.offsets;
      if (a[index] < el.scrollTop) el.scrollTop = a[index];
      else if (a[index + 1] > el.scrollTop + el.clientHeight)
        el.scrollTop = a[index + 1] - el.clientHeight;
    }, [selected]);
    useLayoutEffect(() => {
      const el = scroll.current!;
      const observer = new ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.cue!;
          const h =
            entry.borderBoxSize[0]?.blockSize ||
            entry.target.getBoundingClientRect().height;
          if (h > 0 && Math.abs((heights.current.get(id) || 110) - h) > 1) {
            heights.current.set(id, h);
            changed = true;
          }
        }
        if (changed) setVersion((v) => v + 1);
      });
      el.querySelectorAll("[data-cue]").forEach((node) =>
        observer.observe(node),
      );
      return () => observer.disconnect();
    });
    let first = 0;
    while (first < captions.length && offsets[first + 1] < viewport.top)
      first++;
    let last = first;
    while (
      last < captions.length &&
      offsets[last] < viewport.top + viewport.height
    )
      last++;
    const indices = new Set<number>();
    for (
      let i = Math.max(0, first - 5);
      i < Math.min(captions.length, last + 5);
      i++
    )
      indices.add(i);
    const pinned = captions.findIndex((c) => c.id === focused);
    if (pinned >= 0) indices.add(pinned);
    return (
      <div
        ref={scroll}
        className="caption-scroll"
        tabIndex={0}
        aria-label="Caption list"
        onScroll={(e) =>
          setViewport({
            top: e.currentTarget.scrollTop,
            height: e.currentTarget.clientHeight,
          })
        }
        onFocusCapture={(e) =>
          setFocused(
            (e.target as HTMLElement).closest<HTMLElement>("[data-cue]")
              ?.dataset.cue || "",
          )
        }
      >
        {captions.length ? (
          <div style={{ height: offsets.at(-1), position: "relative" }}>
            {[...indices]
              .sort((a, b) => a - b)
              .map((i) => (
                <div
                  key={captions[i].id}
                  data-cue={captions[i].id}
                  style={{
                    position: "absolute",
                    top: offsets[i],
                    left: 0,
                    right: 0,
                  }}
                >
                  <CaptionRow
                    c={captions[i]}
                    ordinal={ordinal.get(captions[i].id)!}
                    chosen={chosen.has(captions[i].id)}
                    duration={duration}
                    targetLanguage={targetLanguage}
                    {...actions}
                  />
                </div>
              ))}
          </div>
        ) : (
          empty
        )}
      </div>
    );
  },
  (a, b) =>
    a.captions === b.captions &&
    a.selected === b.selected &&
    a.selection === b.selection &&
    a.duration === b.duration &&
    a.targetLanguage === b.targetLanguage &&
    a.actions === b.actions &&
    (a.captions.length > 0 || a.empty === b.empty),
);

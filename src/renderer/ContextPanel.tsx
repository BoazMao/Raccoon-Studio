import React, { useEffect, useState, useRef } from "react";
import type { Project } from "../shared/model";
import {
  approveGuidance,
  emptyGuidance,
  guidanceKey,
  type Guidance,
} from "../shared/context";
import {
  portableGlossary,
  sameGlossaryScope,
  mergeGlossaryTerms,
  type GlossaryScope,
  type GlossaryFile,
} from "../shared/glossary";

export function ContextPanel({
  project,
  visible,
  onChange,
  onClose,
  onCaption,
  onError,
}: {
  project: Project;
  visible: boolean;
  onChange: (p: Project) => void;
  onClose: () => void;
  onCaption: (id: string) => void;
  onError: (e: unknown) => void;
}) {
  const approved = project.translationContext?.approved || emptyGuidance();
  const key = guidanceKey(project);
  const [draft, setDraft] = useState<Guidance>(approved);
  const [glossaryMessage, setGlossaryMessage] = useState("");
  const [glossaryBusy, setGlossaryBusy] = useState(false);
  const [replaceTerms, setReplaceTerms] = useState(false);
  const scope: GlossaryScope = {
    sourceLanguage: project.language as "en" | "zh",
    targetLanguage: project.targetLanguage as "English" | "Chinese",
    chineseVariant: draft.chineseVariant,
  };
  const live = useRef({ id: project.id, draft, scope });
  live.current = { id: project.id, draft, scope };
  useEffect(() => {
    setGlossaryMessage("");
  }, [project.id, project.language, project.targetLanguage]);
  async function glossaryAction(action: () => Promise<void>) {
    setGlossaryBusy(true);
    setGlossaryMessage("");
    try {
      await action();
    } catch (e) {
      onError(e);
    } finally {
      setGlossaryBusy(false);
    }
  }
  function mergeImported(
    incoming: GlossaryFile,
    snapshot: typeof live.current,
  ) {
    if (
      live.current.id !== snapshot.id ||
      live.current.draft !== snapshot.draft ||
      !sameGlossaryScope(live.current.scope, snapshot.scope)
    )
      throw Error(
        "The project or glossary changed while loading. Import again to use the latest edits.",
      );
    if (!sameGlossaryScope(snapshot.scope, incoming))
      throw Error(
        `This glossary is for ${incoming.sourceLanguage} → ${incoming.targetLanguage}${incoming.targetLanguage === "Chinese" ? ` (${incoming.chineseVariant})` : ""}. Choose a matching project language and Chinese variant first.`,
      );
    const merged = mergeGlossaryTerms(
      snapshot.draft.terms,
      incoming.terms,
      replaceTerms,
    );
    const next = { ...snapshot.draft, terms: merged.terms };
    approveGuidance(project, next); // Validate combined limits before modifying the draft.
    setDraft(next);
    setGlossaryMessage(
      `${merged.added} added, ${merged.updated} replaced, ${merged.kept} existing terms kept. Click Save guidance to use these terms.`,
    );
  }
  useEffect(
    () => setDraft(project.translationContext?.approved || emptyGuidance()),
    [project.id, project.language, project.targetLanguage, key],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(approved);
  useEffect(() => {
    if (!visible) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [visible, onClose]);
  if (!visible) return null;
  const evidence = (ids: string[]) => (
    <div className="context-evidence">
      {ids.map((id) => {
        const caption = project.captions.find((c) => c.id === id);
        return (
          <button
            key={id}
            disabled={!caption}
            title={caption?.source}
            onClick={() => onCaption(id)}
          >
            {caption
              ? `Caption ${project.captions.indexOf(caption) + 1}`
              : "Removed caption"}
            : {(caption?.source || "").slice(0, 90)}
          </button>
        );
      })}
    </div>
  );
  return (
    <aside className="context-panel" aria-label="Translation context">
      <div className="context-heading">
        <h3>Translation context</h3>
        <div className="context-actions">
          <button
            className="primary"
            disabled={!dirty}
            onClick={() => {
              try {
                onChange(approveGuidance(project, draft));
              } catch (e) {
                onError(e);
              }
            }}
          >
            Save guidance
          </button>
          <button onClick={onClose} aria-label="Close translation context">
            Close
          </button>
        </div>
      </div>
      <small>
        {dirty
          ? "Unsaved guidance edits — save to use them in translation"
          : "Saved guidance is used in translation requests"}
      </small>
      <section className="context-section">
        <h3>Guidance for translation</h3>
        <label>
          Chinese variant
          <select
            aria-label="Chinese variant"
            value={draft.chineseVariant}
            onChange={(e) =>
              setDraft({
                ...draft,
                chineseVariant: e.target.value as Guidance["chineseVariant"],
              })
            }
          >
            <option>Simplified</option>
            <option>Traditional</option>
          </select>
        </label>
        <label>
          Video description
          <textarea
            aria-label="Video description"
            value={draft.description}
            maxLength={3000}
            rows={3}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </label>
        <label>
          Tone and style
          <input
            aria-label="Tone and style"
            value={draft.tone}
            maxLength={600}
            onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
          />
        </label>
        <h4>Glossary</h4>
        <div className="glossary-tools">
          <button
            disabled={glossaryBusy || !draft.terms.length}
            onClick={() =>
              void glossaryAction(async () => {
                const count = await window.studio.call(
                  "glossarySaveGlobal",
                  portableGlossary(scope, draft.terms),
                );
                setGlossaryMessage(
                  `Saved to global glossary (${count} terms). Matching global terms were updated; other terms were kept.`,
                );
              })
            }
          >
            Save to global
          </button>
          <button
            disabled={glossaryBusy}
            onClick={() =>
              void glossaryAction(async () => {
                const snapshot = live.current;
                const glossary = await window.studio.call(
                  "glossaryLoadGlobal",
                  scope,
                );
                if (glossary) mergeImported(glossary, snapshot);
                else
                  setGlossaryMessage(
                    "No global glossary saved for this language pair and Chinese variant.",
                  );
              })
            }
          >
            Load global
          </button>
          <button
            disabled={glossaryBusy || !draft.terms.length}
            onClick={() =>
              void glossaryAction(async () => {
                const file = await window.studio.call(
                  "glossaryExport",
                  portableGlossary(scope, draft.terms),
                );
                if (file) setGlossaryMessage(`Glossary saved to ${file}`);
              })
            }
          >
            Save to file
          </button>
          <button
            disabled={glossaryBusy}
            onClick={() =>
              void glossaryAction(async () => {
                const snapshot = live.current;
                const glossary = await window.studio.call(
                  "glossaryImport",
                  undefined,
                );
                if (glossary) mergeImported(glossary, snapshot);
              })
            }
          >
            Import file
          </button>
        </div>
        <label>
          When loading duplicate terms
          <select
            aria-label="Glossary duplicate handling"
            value={replaceTerms ? "replace" : "keep"}
            disabled={glossaryBusy}
            onChange={(e) => setReplaceTerms(e.target.value === "replace")}
          >
            <option value="keep">Keep current project terms</option>
            <option value="replace">Use imported terms</option>
          </select>
        </label>
        {glossaryMessage && <p role="status">{glossaryMessage}</p>}
        <small>
          Global and file glossaries contain terms and usage notes for this
          language pair. Load them into a project, then save guidance to approve
          them.
        </small>
        <p>Set the same source and target to preserve a name.</p>
        {draft.terms.map((term, i) => (
          <div className="context-term" key={i}>
            <div className="context-term-fields">
              <label>
                Source
                <input
                  aria-label={`Glossary source ${i + 1}`}
                  value={term.source}
                  maxLength={200}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      terms: draft.terms.map((t, j) =>
                        j === i ? { ...t, source: e.target.value } : t,
                      ),
                    })
                  }
                />
              </label>
              <label>
                Translation
                <input
                  aria-label={`Glossary target ${i + 1}`}
                  value={term.target}
                  maxLength={300}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      terms: draft.terms.map((t, j) =>
                        j === i ? { ...t, target: e.target.value } : t,
                      ),
                    })
                  }
                />
              </label>
            </div>
            <label>
              Usage note
              <input
                aria-label={`Glossary note ${i + 1}`}
                value={term.note}
                maxLength={600}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    terms: draft.terms.map((t, j) =>
                      j === i ? { ...t, note: e.target.value } : t,
                    ),
                  })
                }
              />
            </label>
            {evidence(term.captionIds)}
            <button
              onClick={() =>
                setDraft({
                  ...draft,
                  terms: draft.terms.filter((_, j) => i !== j),
                })
              }
            >
              Remove term {i + 1}
            </button>
          </div>
        ))}
        <button
          disabled={draft.terms.length >= 100}
          onClick={() =>
            setDraft({
              ...draft,
              terms: [
                ...draft.terms,
                { source: "", target: "", note: "", captionIds: [] },
              ],
            })
          }
        >
          Add term
        </button>
        <button disabled={!dirty} onClick={() => setDraft(approved)}>
          Discard guidance edits
        </button>
      </section>
    </aside>
  );
}

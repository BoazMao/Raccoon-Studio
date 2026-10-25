import type { Project } from "./model";
// Editing evidence is persisted, but previous archives/waveforms are not needed
// by media, speech, translation or export operations.
export function operationProject(p: Project): Project {
  return {
    ...p,
    speechRuns: undefined,
    waveform: undefined,
    translationContext: p.translationContext
      ? { approved: p.translationContext.approved }
      : undefined,
  };
}

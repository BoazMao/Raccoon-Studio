import type { Project } from "./model";
export function exportReadiness(p: Project, target: boolean) {
  const sync = p.captions.filter((c) => c.alignment?.needsReview),
    wording = p.captions.filter((c) => c.recognition?.needsReview);
  const stale = target
    ? p.captions.filter((c) => c.status === "stale" || c.status === "failed")
    : [];
  const unchecked = target
    ? p.captions.filter((c) => c.target.trim() && c.status !== "reviewed")
    : [];
  const missing = target ? p.captions.filter((c) => !c.target.trim()) : [];
  return {
    labels: [
      sync.length && `${sync.length} need timing review`,
      wording.length && `${wording.length} need wording review`,
      stale.length && `${stale.length} stale/failed translations`,
      unchecked.length && `${unchecked.length} unreviewed translations`,
      missing.length && `${missing.length} untranslated`,
    ].filter(Boolean) as string[],
    ids: [
      ...new Set(
        [...sync, ...wording, ...stale, ...unchecked, ...missing].map(
          (c) => c.id,
        ),
      ),
    ],
  };
}
export type TimedWord = { text: string; start: number; end: number };
const words = (text: string) =>
  text
    .toLocaleLowerCase("en")
    .replace(/’/g, "'")
    .match(/[\p{L}\p{N}]+(?:['.-][\p{L}\p{N}]+)*/gu) || [];
export function transcriptQuality(
  reference: string,
  actual: string,
  expectedTimes: TimedWord[] = [],
  actualTimes: TimedWord[] = [],
) {
  const a = words(reference),
    b = words(actual);
  if (a.length > 4000 || b.length > 4000)
    throw Error("Use reference clips with at most 4,000 words each");
  const matrix = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  const pairs: [number, number][] = [];
  let i = a.length,
    j = b.length;
  while (i && j) {
    if (a[i - 1] === b[j - 1] && matrix[i][j] === matrix[i - 1][j - 1]) {
      pairs.push([--i, --j]);
    } else if (matrix[i][j] === matrix[i - 1][j - 1] + 1) {
      i--;
      j--;
    } else if (matrix[i][j] === matrix[i - 1][j] + 1) i--;
    else j--;
  }
  const errors: number[] = [];
  // Times are evaluated only when each supplied word corresponds to one
  // normalized transcript token, and only on matched words in the edit path.
  if (expectedTimes.length === a.length && actualTimes.length === b.length)
    for (const [x, y] of pairs) {
      if (
        words(expectedTimes[x].text).join(" ") === a[x] &&
        words(actualTimes[y].text).join(" ") === b[y]
      )
        errors.push(
          Math.abs(expectedTimes[x].start - actualTimes[y].start),
          Math.abs(expectedTimes[x].end - actualTimes[y].end),
        );
    }
  errors.sort((x, y) => x - y);
  return {
    referenceWords: a.length,
    wordErrors: matrix[a.length][b.length],
    wordErrorRate: a.length
      ? matrix[a.length][b.length] / a.length
      : b.length
        ? 1
        : 0,
    matchedTimedWords: errors.length / 2,
    medianBoundaryErrorMs: errors.length
      ? errors[Math.floor((errors.length - 1) * 0.5)] * 1000
      : null,
    p95BoundaryErrorMs: errors.length
      ? errors[Math.ceil((errors.length - 1) * 0.95)] * 1000
      : null,
  };
}

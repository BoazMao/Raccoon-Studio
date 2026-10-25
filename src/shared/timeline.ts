import type { Caption } from "./model";
export function timelineOverview(
  captions: Caption[],
  selected: string,
  duration: number,
  pixels: number,
  start: number,
  end: number,
  overlaps: ReadonlyMap<string, string> = new Map(),
) {
  const individual: Caption[] = [],
    bins = new Map<number, Caption[]>();
  for (const c of captions) {
    if (c.id !== selected && (c.end < start || c.start > end)) continue;
    if (
      c.id === selected ||
      ((c.end - c.start) / duration) * pixels >= 3 ||
      captions.length < 500
    )
      individual.push(c);
    else {
      const key = Math.floor(((c.start / duration) * pixels) / 4);
      const group = bins.get(key) || [];
      group.push(c);
      bins.set(key, group);
    }
  }
  const groups: {
    id: string;
    start: number;
    end: number;
    count: number;
    overlap: boolean;
  }[] = [];
  for (const [bin, items] of bins) {
    if (items.length === 1) individual.push(items[0]);
    else
      groups.push({
        id: String(bin),
        start: items[0].start,
        end: Math.max(...items.map((c) => c.end)),
        count: items.length,
        overlap: items.some((c) => overlaps.has(c.id)),
      });
  }
  return { individual, groups };
}

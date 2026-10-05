import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  GlossaryFileSchema,
  sameGlossaryScope,
  portableGlossary,
  mergeGlossaryTerms,
  type GlossaryFile,
  type GlossaryScope,
} from "../shared/glossary";

const GlobalSchema = z.object({
  version: z.literal(1),
  glossaries: z.array(GlossaryFileSchema).max(8),
});
async function readJson(file: string) {
  if ((await stat(file)).size > 512000)
    throw Error("Glossary file exceeds 500 KB.");
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}
export async function readGlossary(file: string) {
  return GlossaryFileSchema.parse(await readJson(file));
}
const pending = new Map<string, Promise<unknown>>();
function queued<T>(file: string, action: () => Promise<T>): Promise<T> {
  const next = (pending.get(file) || Promise.resolve())
    .catch(() => {})
    .then(action);
  pending.set(file, next);
  void next
    .finally(() => {
      if (pending.get(file) === next) pending.delete(file);
    })
    .catch(() => {});
  return next;
}
async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2), "utf8");
  await rename(file + ".tmp", file);
}
export function writeGlossary(file: string, value: GlossaryFile) {
  const valid = GlossaryFileSchema.parse(value);
  return queued(file, () => atomic(file, valid));
}
async function readGlobal(file: string) {
  try {
    return GlobalSchema.parse(await readJson(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1 as const, glossaries: [] as GlossaryFile[] };
    throw e;
  }
}
export function loadGlobalGlossary(file: string, scope: GlossaryScope) {
  return queued(
    file,
    async () =>
      (await readGlobal(file)).glossaries.find((g) =>
        sameGlossaryScope(g, scope),
      ) || null,
  );
}
export function saveGlobalGlossary(file: string, input: GlossaryFile) {
  const incoming = GlossaryFileSchema.parse(input);
  return queued(file, async () => {
    const store = await readGlobal(file);
    const index = store.glossaries.findIndex((g) =>
      sameGlossaryScope(g, incoming),
    );
    const existing =
      index < 0
        ? []
        : store.glossaries[index].terms.map((t) => ({ ...t, captionIds: [] }));
    const merged = portableGlossary(
      incoming,
      mergeGlossaryTerms(existing, incoming.terms, true).terms,
    );
    if (index < 0) store.glossaries.push(merged);
    else store.glossaries[index] = merged;
    await atomic(file, GlobalSchema.parse(store));
    return merged.terms.length;
  });
}

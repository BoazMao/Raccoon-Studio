import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProjectSchema } from "../src/shared/model";
import { transcriptQuality } from "../src/shared/quality";
const manifestSchema = z.array(
  z.object({
    name: z.string(),
    project: z.string(),
    reference: z.string(),
    words: z
      .array(
        z.object({
          text: z.string(),
          start: z.number().finite(),
          end: z.number().finite(),
        }),
      )
      .optional(),
    humanTranslationReview: z
      .object({
        omissions: z.number().nonnegative(),
        additions: z.number().nonnegative(),
        negationErrors: z.number().nonnegative(),
        terminologyErrors: z.number().nonnegative(),
      })
      .optional(),
  }),
);
void (async () => {
  const manifest = process.argv[2];
  if (!manifest)
    throw Error(
      "Usage: npm run test:quality -- path/to/references.json (reviewed reference clips required)",
    );
  const fixtures = manifestSchema.parse(
    JSON.parse(await readFile(manifest, "utf8")),
  );
  for (const fixture of fixtures) {
    const p = ProjectSchema.parse(
      JSON.parse(
        await readFile(
          path.resolve(path.dirname(manifest), fixture.project),
          "utf8",
        ),
      ),
    );
    const raw = p.speechRuns
      ?.filter((run) => run.mode === "transcription")
      .at(-1)?.raw;
    const segments = (
      raw?.transcription as { segments?: { text: string }[] } | undefined
    )?.segments;
    const alignments = raw?.alignments as
      | {
          output?: {
            word_segments?: { word: string; start?: number; end?: number }[];
          };
        }[]
      | undefined;
    const timed = (alignments || [])
      .flatMap((a) => a.output?.word_segments || [])
      .filter((w) => w.start !== undefined && w.end !== undefined)
      .map((w) => ({ text: w.word, start: w.start!, end: w.end! }));
    console.log(
      JSON.stringify({
        name: fixture.name,
        recognition: transcriptQuality(
          fixture.reference,
          (segments || p.captions.map((c) => ({ text: c.source })))
            .map((s) => s.text)
            .join(" "),
          fixture.words,
          timed,
        ),
        humanTranslationReview: fixture.humanTranslationReview || null,
      }),
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

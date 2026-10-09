import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blank,
  ProjectSchema,
  timestampedText,
  type Caption,
} from "../src/shared/model";

test("timestamped text sorts cues, rounds milliseconds, retains Unicode and omits empty tracks", () => {
  const cue = (
    id: string,
    start: number,
    source: string,
    target: string,
  ): Caption => ({
    id,
    start,
    end: start + 1.5004,
    source,
    target,
    status: "draft",
  });
  const p = {
    ...blank(),
    media: {
      path: "speech.mp3",
      kind: "audio" as const,
      duration: 4000,
      fps: 30,
    },
    captions: [
      cue("later", 3661.2504, " Later ", "稍后"),
      cue("first", 0.9996, "Hello\nworld", ""),
      cue("empty", 2, "  ", "译文"),
    ],
  };
  assert.equal(
    timestampedText(p, "source"),
    "[00:00:01.000 → 00:00:02.500] Hello\nworld\r\n\r\n[01:01:01.250 → 01:01:02.751] Later\r\n",
  );
  assert.equal(
    timestampedText(p, "target"),
    "[00:00:02.000 → 00:00:03.500] 译文\r\n\r\n[01:01:01.250 → 01:01:02.751] 稍后\r\n",
  );
  assert.equal(p.captions[0].id, "later");
  assert.equal(
    ProjectSchema.parse(JSON.parse(JSON.stringify(p))).media!.kind,
    "audio",
  );
  assert.equal(
    ProjectSchema.parse({
      ...blank(),
      media: { path: "old.mp4", fps: 30, duration: 2 },
    }).media!.kind,
    undefined,
  );
});

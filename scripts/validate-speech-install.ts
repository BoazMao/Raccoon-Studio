// Opt-in real installer validation. Never touches the user's active runtime/settings.
import path from "node:path";
import { installWhisperX } from "../src/main/install-whisperx";
import { RuntimeProfileSchema } from "../src/shared/speech-runtime";
const profile = RuntimeProfileSchema.parse(
  process.env.TEST_RUNTIME_PROFILE || "cuda",
);
const root = path.resolve(
  process.env.TEST_RUNTIME_ROOT ||
    ".tools/test-work/gpu-profile/runtime/whisperx",
);
const started = Date.now();
void installWhisperX(
  root,
  new AbortController().signal,
  (progress, message) => console.log(`${progress}% ${message}`),
  { profile },
)
  .then((python) =>
    console.log(
      JSON.stringify({ python, installSeconds: (Date.now() - started) / 1000 }),
    ),
  )
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

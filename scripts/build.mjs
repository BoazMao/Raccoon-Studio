import { build } from "esbuild";
import { mkdir, copyFile, cp } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main.cjs",
});
await build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/preload.cjs",
});
await build({
  entryPoints: ["src/renderer/index.tsx"],
  bundle: true,
  platform: "browser",
  outfile: "dist/renderer.js",
});
await copyFile("src/renderer/index.html", "dist/index.html");
await copyFile("scripts/whisperx_worker.py", "dist/whisperx_worker.py");
await cp("scripts/speech-runtime", "dist/speech-runtime", { recursive: true });
await copyFile("assets/Raccoon.ico", "dist/Raccoon.ico");

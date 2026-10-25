import { build } from "esbuild";
await build({
  entryPoints: ["src/main/project-worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/project-worker.cjs",
});

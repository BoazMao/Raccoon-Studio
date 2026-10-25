import { parentPort } from "node:worker_threads";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { ProjectSchema } from "../shared/model";
let queue = Promise.resolve();
parentPort!.on("message", (request) => {
  queue = queue.then(async () => {
    try {
      if (request.operation === "read") {
        const project = ProjectSchema.parse(
          JSON.parse(await readFile(request.file, "utf8")),
        );
        parentPort!.postMessage({ id: request.id, project });
      } else {
        const project = ProjectSchema.parse(request.project);
        const contents = JSON.stringify(project);
        for (const file of request.files as string[]) {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file + ".tmp", contents, "utf8");
          await rename(file + ".tmp", file);
        }
        parentPort!.postMessage({ id: request.id });
      }
    } catch (error) {
      parentPort!.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

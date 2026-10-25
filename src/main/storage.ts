import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Project } from "../shared/model";
type Operation = {
  request: Record<string, unknown>;
  key?: string;
  resolve: ((value: Project | undefined) => void)[];
  reject: ((error: Error) => void)[];
};
const waiting: Operation[] = [];
let worker: Worker | undefined,
  active: Operation | undefined,
  sequence = 0;
function pump() {
  if (active || !waiting.length) return;
  if (!worker) {
    const bundled = path.join(__dirname, "project-worker.cjs");
    const file = existsSync(bundled)
      ? bundled
      : path.resolve("dist/project-worker.cjs");
    const instance = (worker = new Worker(file));
    instance.on("message", (message) => {
      if (worker !== instance || !active || message.id !== active.request.id)
        return;
      const done = active;
      active = undefined;
      if (message.error) done.reject.forEach((fn) => fn(Error(message.error)));
      else done.resolve.forEach((fn) => fn(message.project));
      instance.unref();
      pump();
    });
    const failed = (error: Error) => {
      if (worker !== instance) return;
      worker = undefined;
      if (active) {
        active.reject.forEach((fn) => fn(error));
        active = undefined;
      }
      void instance.terminate();
      pump();
    };
    instance.once("error", failed);
    instance.once("exit", () =>
      failed(Error("Project worker stopped unexpectedly")),
    );
  }
  active = waiting.shift()!;
  worker.ref();
  worker.postMessage(active.request);
}
function perform(
  request: Record<string, unknown>,
  key?: string,
): Promise<Project | undefined> {
  return new Promise((resolve, reject) => {
    const last = waiting.at(-1);
    if (key && last?.key === key) {
      last.request = { ...request, id: ++sequence };
      last.resolve.push(resolve);
      last.reject.push(reject);
    } else
      waiting.push({
        request: { ...request, id: ++sequence },
        key,
        resolve: [resolve],
        reject: [reject],
      });
    pump();
  });
}
export async function readProject(file: string): Promise<Project> {
  return (await perform({ operation: "read", file }))!;
}
export async function writeProjectFiles(
  files: string[],
  project: Project,
  autosave = false,
) {
  await perform(
    { operation: "write", files, project },
    autosave ? `autosave:${project.id}` : undefined,
  );
}
export function writeProject(file: string, project: Project) {
  return writeProjectFiles([file], project);
}

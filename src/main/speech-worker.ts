import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { run } from "./jobs";

// One warm interpreter, never concurrent inference. Models are released by the
// server after each request. Any cancellation/failure discards the interpreter.
export class SpeechWorker {
  private child?: ChildProcessWithoutNullStreams;
  private key = "";
  private idle?: NodeJS.Timeout;
  private pending?: (ok: boolean, error?: string) => void;
  private busy = false;
  private stderr = "";
  private carry = "";
  constructor(
    private idleMs = 90000,
    private launch = (exe: string, args: string[]) =>
      spawn(exe, args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
  ) {}
  async stop() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.key = "";
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      if (process.platform === "win32" && child.pid) {
        const kill = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true },
        );
        kill.once("error", () => child.kill());
        kill.once("exit", (code) => {
          if (code !== 0) child.kill();
        });
      } else child.kill();
    });
  }
  run: typeof run = async (
    exe,
    args,
    signal,
    onText = () => {},
    onBinary,
    env,
  ) => {
    if (args[0] !== "-u" || !args[1]?.endsWith("whisperx_worker.py"))
      return run(exe, args, signal, onText, onBinary, env);
    if (this.busy) throw Error("Speech interpreter is already busy");
    this.busy = true;
    try {
      signal.throwIfAborted();
      const request = JSON.parse(await readFile(args[2], "utf8"));
      if (request.reuse === false) {
        await this.stop();
        return await run(exe, args, signal, onText, onBinary, env);
      }
      const key = JSON.stringify([
        exe,
        args[1],
        request.cache,
        request.offline,
      ]);
      clearTimeout(this.idle);
      if (this.child && this.key !== key) await this.stop();
      this.stderr = "";
      this.carry = "";
      if (!this.child) {
        const child = (this.child = this.launch(exe, [
          "-u",
          args[1],
          "--serve",
        ]));
        this.key = key;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (data: string) => {
          this.carry += data;
          if (this.carry.length > 1000000) {
            this.pending?.(false, "Speech protocol output exceeded its limit");
            return;
          }
          const lines = this.carry.split(/\r?\n/);
          this.carry = lines.pop() || "";
          for (const line of lines) {
            let done: { type?: string; ok?: boolean } | undefined;
            try {
              if (line.startsWith("STUDIO:")) done = JSON.parse(line.slice(7));
            } catch {
              /* diagnostic line */
            }
            if (done?.type === "workerDone")
              this.pending?.(Boolean(done.ok), this.stderr);
            else this.forward?.(line + "\n");
          }
        });
        child.stderr.on("data", (text: string) => {
          this.stderr = (this.stderr + text).slice(-4000);
          this.diagnostic?.(text);
        });
        child.once("error", (error) => {
          if (this.child === child) this.pending?.(false, error.message);
        });
        child.once("close", () => {
          if (this.child === child) {
            this.child = undefined;
            this.key = "";
            this.pending?.(false, this.stderr || "Speech interpreter stopped");
          }
        });
      }
      this.forward = (text) =>
        onBinary ? onBinary(Buffer.from(text, "utf8")) : onText(text);
      this.diagnostic = onText;
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const abort = () => this.pending?.(false, "Cancelled");
        this.pending = (ok, error) => {
          if (settled) return;
          settled = true;
          this.pending = undefined;
          this.forward = undefined;
          this.diagnostic = undefined;
          signal.removeEventListener("abort", abort);
          if (ok && !signal.aborted) {
            this.idle = setTimeout(() => void this.stop(), this.idleMs);
            this.idle.unref();
            resolve("");
          } else
            void this.stop().then(() =>
              reject(
                Error(
                  signal.aborted
                    ? "Cancelled"
                    : error || "Speech worker failed",
                ),
              ),
            );
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        else
          this.child!.stdin.write(JSON.stringify(args[2]) + "\n", (error) => {
            if (error) this.pending?.(false, error.message);
          });
      });
    } finally {
      this.busy = false;
    }
  };
  private forward?: (text: string) => void;
  private diagnostic?: (text: string) => void;
}

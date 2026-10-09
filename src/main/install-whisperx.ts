import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  readdir,
  statfs,
  access,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { run } from "./jobs";
import { z } from "zod";
import type { RuntimeProfile } from "../shared/speech-runtime";

const runtimeKey = "whisperx-3.8.6-python-3.12.14-cpu-v1";
const uvURL =
  "https://github.com/astral-sh/uv/releases/download/0.12.21/uv-x86_64-pc-windows-msvc.zip";
const uvHash =
  "5d223efa0bf00208c3853246af09420419dfbd352536aa6bb8163d6170e23890";
const ManifestSchema = z.object({
  key: z.string(),
  profile: z.enum(["cpu", "cuda"]).optional(),
  python: z.string().regex(/^environments\/[0-9a-f-]+\/Scripts\/python\.exe$/),
  installedAt: z.string().optional(),
  verifiedAt: z.string().optional(),
  lockHash: z.string().optional(),
  previous: z
    .string()
    .regex(/^environments\/[0-9a-f-]+\/Scripts\/python\.exe$/)
    .optional(),
  trimmedBuildBytes: z.number().nonnegative().optional(),
});

const torchBuildLibraries = new Set([
  "_C.lib",
  "asmjit.lib",
  "c10_cuda.lib",
  "c10.lib",
  "caffe2_nvrtc.lib",
  "cpuinfo.lib",
  "dnnl.lib",
  "fbgemm.lib",
  "fmt.lib",
  "kineto.lib",
  "libittnotify.lib",
  "libprotobuf-lite.lib",
  "libprotobuf.lib",
  "libprotoc.lib",
  "microkernels-prod.lib",
  "pthreadpool.lib",
  "shm.lib",
  "sleef.lib",
  "torch_cpu.lib",
  "torch_cuda.lib",
  "torch_python.lib",
  "torch.lib",
  "XNNPACK.lib",
]);

// These are link-time artifacts for the locked 2.8.0 Windows wheels. Inference
// uses their DLLs. This never runs against a user-supplied Python environment.
export async function trimTorchBuildLibraries(
  environment: string,
  profile: RuntimeProfile,
) {
  const site = path.join(environment, "Lib", "site-packages");
  const libraries = path.join(site, "torch", "lib");
  const entries = await readdir(libraries, { withFileTypes: true }).catch(
    () => [],
  );
  if (!entries.length) return 0;
  const version = `2.8.0+${profile === "cuda" ? "cu128" : "cpu"}`;
  const metadata = await readFile(
    path.join(site, `torch-${version}.dist-info`, "METADATA"),
    "utf8",
  );
  if (!metadata.split(/\r?\n/).includes(`Version: ${version}`))
    throw Error("Unexpected PyTorch version; refusing build-artifact trimming");
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !torchBuildLibraries.has(entry.name)) continue;
    const file = owned(environment, path.join(libraries, entry.name));
    const size = (await stat(file)).size;
    await rm(file);
    removed += size;
  }
  return removed;
}

export async function managedRuntime(root: string) {
  try {
    const manifest = ManifestSchema.parse(
      JSON.parse(await readFile(path.join(root, "current.json"), "utf8")),
    );
    if (
      manifest.key !== runtimeKey &&
      !/^whisperx-3\.8\.6-python-3\.12\.14-(cpu|cuda)-v2$/.test(manifest.key)
    )
      return;
    const python = owned(root, path.resolve(root, manifest.python));
    await access(python);
    return {
      ...manifest,
      profile: manifest.profile || ("cpu" as RuntimeProfile),
      executable: python,
    };
  } catch {
    return;
  }
}

function owned(root: string, file: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw Error("Invalid managed runtime path");
  return file;
}

export async function managedPython(root: string): Promise<string | undefined> {
  return (await managedRuntime(root))?.executable;
}

export async function markRuntimeVerified(root: string, python: string) {
  const manifest = await managedRuntime(root);
  if (!manifest || manifest.executable !== python || manifest.verifiedAt)
    return;
  const { executable, ...saved } = manifest;
  await writeFile(
    path.join(root, "verified.tmp"),
    JSON.stringify({ ...saved, verifiedAt: new Date().toISOString() }),
  );
  await rename(
    path.join(root, "verified.tmp"),
    path.join(root, "current.json"),
  );
}

export async function directoryBytes(root: string): Promise<number> {
  let bytes = 0;
  const directories = [root];
  while (directories.length) {
    const batch = directories.splice(0, 8);
    await Promise.all(
      batch.map(async (directory) => {
        const entries = await readdir(directory, { withFileTypes: true }).catch(
          () => [],
        );
        for (let i = 0; i < entries.length; i += 16) {
          await Promise.all(
            entries.slice(i, i + 16).map(async (entry) => {
              const file = path.join(directory, entry.name);
              if (entry.isDirectory()) directories.push(file);
              else if (entry.isFile()) {
                const size = (await stat(file)).size;
                bytes += size;
              }
            }),
          );
        }
      }),
    );
  }
  return bytes;
}

// Caller holds the speech resource slot. Only UUID environments owned by this manager are removed.
export async function cleanupRuntime(root: string, keepPrevious = false) {
  const manifest = await managedRuntime(root);
  if (!manifest) throw Error("No managed WhisperX installation is active");
  if (!manifest.verifiedAt)
    throw Error(
      "Complete a transcription with this runtime before removing previous installations",
    );
  const active = manifest.python.split("/")[1];
  for (const entry of await readdir(path.join(root, "environments"), {
    withFileTypes: true,
  })) {
    if (
      entry.isDirectory() &&
      /^[0-9a-f-]{36}$/.test(entry.name) &&
      entry.name !== active &&
      (!keepPrevious || entry.name !== manifest.previous?.split("/")[1])
    )
      await rm(owned(root, path.join(root, "environments", entry.name)), {
        recursive: true,
        force: true,
      });
  }
  const { executable, previous, ...saved } = manifest;
  await writeFile(
    path.join(root, "cleanup.tmp"),
    JSON.stringify({ ...saved, ...(keepPrevious ? { previous } : {}) }),
  );
  await rename(path.join(root, "cleanup.tmp"), path.join(root, "current.json"));
}

async function findUV(root: string): Promise<string | undefined> {
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.name === "uv.exe") return path.join(root, item.name);
    if (item.isDirectory()) {
      const found = await findUV(path.join(root, item.name));
      if (found) return found;
    }
  }
}

async function bootstrap(
  root: string,
  signal: AbortSignal,
  update: (n: number, message: string) => void,
) {
  const tools = path.join(root, "bootstrap");
  await mkdir(tools, { recursive: true });
  const zip = path.join(tools, "uv.zip");
  const verified = async () =>
    createHash("sha256")
      .update(await readFile(zip))
      .digest("hex") === uvHash;
  if (!(await verified().catch(() => false))) {
    const response = await fetch(uvURL, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
    });
    if (!response.ok || !response.body)
      throw Error(
        `Installer download failed (${response.status}). Retry with an internet connection.`,
      );
    const total = Number(response.headers.get("content-length"));
    let bytes = 0;
    let lastUpdate = 0;
    const stream = Readable.fromWeb(response.body as any);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (Date.now() - lastUpdate < 200 && bytes !== total) return;
      lastUpdate = Date.now();
      update(
        total ? Math.min(10, (bytes / total) * 10) : 5,
        `Downloading installer: ${(bytes / 1e6).toFixed(1)} MB`,
      );
    });
    await pipeline(stream, createWriteStream(zip), { signal });
  }
  if (!(await verified()))
    throw Error("Installer checksum mismatch. Retry installation.");
  signal.throwIfAborted();
  await run(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:RACCOON_UV_ZIP -DestinationPath $env:RACCOON_UV_DIR -Force",
    ],
    signal,
    undefined,
    undefined,
    { RACCOON_UV_ZIP: zip, RACCOON_UV_DIR: path.join(tools, "uv") },
  );
  const uv = await findUV(path.join(tools, "uv"));
  if (!uv) throw Error("Installer archive has no uv.exe");
  return uv;
}

type Dependencies = {
  runner?: typeof run;
  bootstrap?: typeof bootstrap;
  checkDisk?: boolean;
  beginCommit?: () => void;
  renameMarker?: typeof rename;
  profile?: RuntimeProfile;
  lockDirectory?: string;
};
export async function installWhisperX(
  root: string,
  signal: AbortSignal,
  update: (n: number, message: string) => void,
  dependencies: Dependencies = {},
) {
  await mkdir(root, { recursive: true });
  const profile = dependencies.profile || "cpu";
  const previous = await managedRuntime(root);
  // Bound managed backups while retaining the current and immediate previous
  // environments. A never-verified runtime cannot authorize this cleanup.
  if (previous?.verifiedAt) await cleanupRuntime(root);
  if (dependencies.checkDisk !== false) {
    const disk = await statfs(root);
    const required = profile === "cuda" ? 12 : 6;
    if (disk.bavail * disk.bsize < required * 1024 ** 3)
      throw Error(
        `WhisperX ${profile.toUpperCase()} installation needs at least ${required} GiB of free disk space, including staging and temporary downloads. Free space and retry.`,
      );
  }
  const execute = dependencies.runner || run;
  const directory = owned(root, path.join(root, "environments", randomUUID()));
  const python = path.join(directory, "Scripts", "python.exe");
  const environment = {
    UV_PYTHON_INSTALL_DIR: path.join(root, "python"),
    UV_CACHE_DIR: path.join(root, "cache"),
    UV_PYTHON_BIN_DIR: path.join(root, "bin"),
    UV_LINK_MODE: "hardlink",
    UV_PYTHON_INSTALL_REGISTRY: "false",
    UV_NO_MODIFY_PATH: "1",
  };
  const stage = (n: number, title: string) => (text: string) => {
    const detail = text
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split(/[\r\n]/)
      .filter(Boolean)
      .at(-1)
      ?.trim();
    update(n, detail ? `${title}: ${detail.slice(0, 200)}` : title);
  };
  try {
    signal.throwIfAborted();
    update(1, "Downloading verified installer");
    const uv = await (dependencies.bootstrap || bootstrap)(
      root,
      signal,
      update,
    );
    update(12, "Installing private Python 3.12.14");
    await execute(
      uv,
      [
        "venv",
        "--managed-python",
        "--python",
        "3.12.14",
        "--no-project",
        directory,
      ],
      signal,
      stage(20, "Installing private Python"),
      undefined,
      environment,
    );
    update(25, `Installing locked ${profile.toUpperCase()} speech libraries`);
    const lockFile = path.join(
      dependencies.lockDirectory || path.resolve("scripts/speech-runtime"),
      `${profile}.txt`,
    );
    const lockHash = createHash("sha256")
      .update(await readFile(lockFile))
      .digest("hex");
    await execute(
      uv,
      [
        "pip",
        "sync",
        "--python",
        python,
        "--no-cache",
        "--only-binary",
        ":all:",
        "--require-hashes",
        "--find-links",
        path.join(path.dirname(lockFile), "wheels"),
        "--index-url",
        "https://pypi.org/simple",
        lockFile,
      ],
      signal,
      stage(50, `Installing ${profile.toUpperCase()} libraries`),
      undefined,
      environment,
    );
    update(85, "Removing developer-only static link libraries");
    const trimmedBuildBytes = await trimTorchBuildLibraries(directory, profile);
    update(90, "Verifying recognition and alignment modules");
    await execute(
      python,
      [
        "-I",
        "-c",
        `import os, pathlib, ctypes; import importlib.metadata as m; import torch,torchaudio; handles=[os.add_dll_directory(str(pathlib.Path(torch.__file__).parent/'lib'))]; from whisperx.asr import load_model; from whisperx.alignment import load_align_model; import ctranslate2; assert m.version('whisperx') == '3.8.6'; assert m.version('transformers') == '4.57.6'; assert torch.__version__ == '2.8.0+${profile === "cuda" ? "cu128" : "cpu"}'; assert torchaudio.__version__ == torch.__version__; assert torch.ones(2,device='cpu').sum().item()==2; ${profile === "cuda" ? "assert torch.cuda.is_available(), 'NVIDIA CUDA is unavailable: check the driver'; ctypes.WinDLL('cublas64_12.dll'); ctypes.WinDLL('cudnn64_9.dll'); assert 'float16' in ctranslate2.get_supported_compute_types('cuda'); torch.nn.functional.conv1d(torch.ones((1,1,16),device='cuda'),torch.ones((1,1,3),device='cuda')); torch.cuda.synchronize();" : ""} print('WhisperX runtime ready; selected models are verified on first transcription')`,
      ],
      signal,
    );
    signal.throwIfAborted();
    const marker = path.join(root, "current.json"),
      temporary = marker + ".tmp";
    await writeFile(
      temporary,
      JSON.stringify({
        key: `whisperx-3.8.6-python-3.12.14-${profile}-v2`,
        profile,
        trimmedBuildBytes,
        lockHash,
        previous: previous?.python,
        python: path.relative(root, python).replaceAll(path.sep, "/"),
        installedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    signal.throwIfAborted();
    dependencies.beginCommit?.();
    await (dependencies.renameMarker || rename)(temporary, marker);
    return python;
  } catch (error) {
    await rm(owned(root, directory), { recursive: true, force: true });
    throw error;
  }
}

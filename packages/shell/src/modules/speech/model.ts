import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  isSpeechModelId,
  SPEECH_ACCURATE_MODEL,
  SPEECH_MODEL_VERIFIED_FILE,
  SPEECH_MODELS_PATH,
  SPEECH_VAD_MODEL,
  type SpeechOpenResult,
} from "@gram/contracts";

import type { SpeechAccuratePaths, SpeechModelPaths } from "../../speech-process/protocol.ts";

/** The recogniser this shell runs; a model for another is refused rather than half-loaded. */
const RECOGNIZER_KIND = "sherpa-onnx-online-transducer";
const OFFLINE_KIND = "sherpa-onnx-offline-transducer";
const VAD_KIND = "sherpa-onnx-silero-vad";
/** The chunk of a manifest that names none: the first export's, 560 ms. */
const DEFAULT_CHUNK_MS = 560;

export type SpeechModelResolution =
  | { readonly ok: true; readonly paths: SpeechModelPaths }
  | Extract<SpeechOpenResult, { readonly ok: false }>;

export interface ModelFs {
  readonly readFile: (path: string) => Promise<string>;
  readonly size: (path: string) => Promise<number>;
  /** The path with every symlink resolved; rejects when it doesn't exist. */
  readonly realpath: (path: string) => Promise<string>;
}

export const nodeModelFs: ModelFs = {
  readFile: (path) => readFile(path, "utf8"),
  size: async (path) => (await stat(path)).size,
  realpath: (path) => realpath(path),
};

/** Whether `path` lies strictly inside `dir`; both already canonical. */
const isInside = (dir: string, path: string): boolean => {
  const inside = relative(dir, path);
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
};

/** `path` with its symlinks resolved, if that is still inside `dir`; else undefined. */
const realInside = async (fs: ModelFs, dir: string, path: string) => {
  try {
    const real = await fs.realpath(path);
    return isInside(dir, real) ? real : undefined;
  } catch {
    return undefined;
  }
};

const missing = (message: string): SpeechModelResolution => ({
  ok: false,
  code: "model-missing",
  message,
});

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** An installed model's directory, what its `verified.json` says, and each file's verified size. */
interface Verified {
  readonly dir: string;
  readonly recognizer: unknown;
  readonly sizes: ReadonlyMap<string, number>;
}

const readVerified = async (
  dataDir: string,
  modelId: string,
  fs: ModelFs,
): Promise<Verified | undefined> => {
  let root: string;
  try {
    root = await fs.realpath(join(dataDir, ...SPEECH_MODELS_PATH));
  } catch {
    return undefined;
  }
  const dir = await realInside(fs, root, join(root, modelId));
  const manifest = dir && (await realInside(fs, dir, join(dir, SPEECH_MODEL_VERIFIED_FILE)));
  if (dir === undefined || manifest === undefined) return undefined;
  let verified: unknown;
  try {
    verified = JSON.parse(await fs.readFile(manifest));
  } catch {
    // Still being written, or not the server's: either way the model isn't installed.
    return undefined;
  }
  const files = field(verified, "files");
  const sizes = new Map<string, number>();
  if (Array.isArray(files)) {
    for (const file of files) {
      const path = field(file, "path");
      const size = field(file, "size");
      if (typeof path === "string" && typeof size === "number") sizes.set(path, size);
    }
  }
  return { dir, recognizer: field(verified, "recognizer"), sizes };
};

/** The file a recogniser names for `role`, or why it isn't the file that was verified. */
const verifiedFile = async (
  fs: ModelFs,
  { dir, recognizer, sizes }: Verified,
  modelId: string,
  role: string,
): Promise<{ readonly path: string } | { readonly problem: string }> => {
  const name = field(recognizer, role);
  if (typeof name !== "string") return { problem: `${modelId}'s manifest names no ${role}` };
  const path = await realInside(fs, dir, resolve(dir, name));
  if (path === undefined)
    return { problem: `${modelId}'s ${role} is missing or outside its directory` };
  const expected = sizes.get(name);
  let actual: number;
  try {
    actual = await fs.size(path);
  } catch {
    return { problem: `${modelId}'s ${role} is missing` };
  }
  if (expected === undefined || actual !== expected)
    return { problem: `${modelId}'s ${role} isn't the verified file` };
  return { path };
};

const TRANSDUCER_ROLES = ["encoder", "decoder", "joiner", "tokens"] as const;

/**
 * Resolves an installed model to the files its recogniser loads, from the server's `verified.json`
 * in `<dataDir>/speech/models/<modelId>/`. Only an id comes from the page. Every path is taken with
 * its symlinks resolved, and one that lands outside the model's directory, or a file whose size on
 * disk isn't the verified one, makes the model `model-missing`. Sizes only: re-hashing 680 MB on
 * every load would cost about a second.
 */
export async function resolveSpeechModel(
  dataDir: string,
  modelId: unknown,
  fs: ModelFs = nodeModelFs,
): Promise<SpeechModelResolution> {
  if (!isSpeechModelId(modelId)) return missing("not a model id");
  const verified = await readVerified(dataDir, modelId, fs);
  if (verified === undefined) return missing(`${modelId} isn't installed`);
  const { recognizer } = verified;
  if (field(recognizer, "kind") !== RECOGNIZER_KIND) {
    return missing(`${modelId} isn't a model this version can run`);
  }
  const chunk = field(recognizer, "chunkMs");
  const chunkMs =
    typeof chunk === "number" && Number.isInteger(chunk) && chunk > 0 && chunk <= 10_000
      ? chunk
      : DEFAULT_CHUNK_MS;
  const paths: Partial<Record<(typeof TRANSDUCER_ROLES)[number], string>> = {};
  for (const role of TRANSDUCER_ROLES) {
    const file = await verifiedFile(fs, verified, modelId, role);
    if ("problem" in file) return missing(file.problem);
    paths[role] = file.path;
  }
  return { ok: true, paths: { ...(paths as Omit<SpeechModelPaths, "chunkMs">), chunkMs } };
}

/**
 * What `accurate` mode runs, held to the same checks, or undefined unless all of it is installed:
 * a session without it stays `live`.
 */
export async function resolveAccurateModels(
  dataDir: string,
  fs: ModelFs = nodeModelFs,
): Promise<SpeechAccuratePaths | undefined> {
  const offline = await readVerified(dataDir, SPEECH_ACCURATE_MODEL, fs);
  const detector = await readVerified(dataDir, SPEECH_VAD_MODEL, fs);
  if (offline === undefined || detector === undefined) return undefined;
  if (field(offline.recognizer, "kind") !== OFFLINE_KIND) return undefined;
  if (field(detector.recognizer, "kind") !== VAD_KIND) return undefined;
  const paths: Partial<Record<(typeof TRANSDUCER_ROLES)[number], string>> = {};
  for (const role of TRANSDUCER_ROLES) {
    const file = await verifiedFile(fs, offline, SPEECH_ACCURATE_MODEL, role);
    if ("problem" in file) return undefined;
    paths[role] = file.path;
  }
  const vad = await verifiedFile(fs, detector, SPEECH_VAD_MODEL, "model");
  if ("problem" in vad) return undefined;
  return { ...(paths as Omit<SpeechAccuratePaths, "vad">), vad: vad.path };
}

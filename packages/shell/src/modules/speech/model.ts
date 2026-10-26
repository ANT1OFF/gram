import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  isSpeechModelId,
  SPEECH_MODEL_VERIFIED_FILE,
  SPEECH_MODELS_PATH,
  type SpeechOpenResult,
} from "@gram/contracts";

import type { SpeechModelPaths } from "../../speech-process/protocol.ts";

/** The recogniser this shell runs; a model for another is refused rather than half-loaded. */
const RECOGNIZER_KIND = "sherpa-onnx-online-transducer";
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
  let root: string;
  try {
    root = await fs.realpath(join(dataDir, ...SPEECH_MODELS_PATH));
  } catch {
    return missing(`${modelId} isn't installed`);
  }
  const dir = await realInside(fs, root, join(root, modelId));
  const manifest = dir && (await realInside(fs, dir, join(dir, SPEECH_MODEL_VERIFIED_FILE)));
  if (dir === undefined || manifest === undefined) return missing(`${modelId} isn't installed`);
  let verified: unknown;
  try {
    verified = JSON.parse(await fs.readFile(manifest));
  } catch {
    // Still being written, or not the server's: either way the model isn't installed.
    return missing(`${modelId} isn't installed`);
  }
  const recognizer = field(verified, "recognizer");
  if (field(recognizer, "kind") !== RECOGNIZER_KIND) {
    return missing(`${modelId} isn't a model this version can run`);
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

  const chunk = field(recognizer, "chunkMs");
  const chunkMs =
    typeof chunk === "number" && Number.isInteger(chunk) && chunk > 0 && chunk <= 10_000
      ? chunk
      : DEFAULT_CHUNK_MS;
  const paths: Partial<Record<"encoder" | "decoder" | "joiner" | "tokens", string>> = {};
  for (const role of ["encoder", "decoder", "joiner", "tokens"] as const) {
    const name = field(recognizer, role);
    if (typeof name !== "string") return missing(`${modelId}'s manifest names no ${role}`);
    const path = await realInside(fs, dir, resolve(dir, name));
    if (path === undefined)
      return missing(`${modelId}'s ${role} is missing or outside its directory`);
    const expected = sizes.get(name);
    let actual: number;
    try {
      actual = await fs.size(path);
    } catch {
      return missing(`${modelId}'s ${role} is missing`);
    }
    if (expected === undefined || actual !== expected) {
      return missing(`${modelId}'s ${role} isn't the verified file`);
    }
    paths[role] = path;
  }
  return { ok: true, paths: { ...(paths as Omit<SpeechModelPaths, "chunkMs">), chunkMs } };
}

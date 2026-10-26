import { open, realpath } from "node:fs/promises";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const PROBE_MARKER = "__SB_PROBE__";
const ENV_MARKER = "__SB_ENV__";

/** Prints `command -v <name>` and `env -0` between NUL-delimited markers, so shell banners can't interfere. */
export const probeScript = (name: string): string =>
  `printf '\\0${PROBE_MARKER}\\0'; command -v ${name}; printf '\\0${ENV_MARKER}\\0'; env -0`;

export interface ProbeResult {
  /** What `command -v <name>` printed, when it is an absolute path. */
  readonly commandPath?: string;
  readonly env: Record<string, string>;
}

export const parseProbeOutput = (stdout: string): ProbeResult => {
  const start = stdout.lastIndexOf(`\0${PROBE_MARKER}\0`);
  const body = start === -1 ? stdout : stdout.slice(start + PROBE_MARKER.length + 2);
  const split = body.indexOf(`\0${ENV_MARKER}\0`);
  const which = (split === -1 ? body : body.slice(0, split)).trim();
  const env: Record<string, string> = {};
  if (split !== -1) {
    for (const entry of body.slice(split + ENV_MARKER.length + 2).split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  // `command -v` prints an alias definition or a bare name for non-path results.
  const commandPath = which.split("\n").at(-1)?.trim();
  return commandPath !== undefined && /^([/\\]|[A-Za-z]:)/.test(commandPath)
    ? { commandPath, env }
    : { env };
};

// ---------------------------------------------------------------------------------------------
// Candidates and wrapper detection

export type ExecutableKind = "native" | "script" | "shellWrapper" | "unknown";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Classifies an executable from its first bytes. */
export const classifyExecutable = (head: Uint8Array): ExecutableKind => {
  const [b0, b1, b2, b3] = head;
  const magic = ((b0 ?? 0) << 24) | ((b1 ?? 0) << 16) | ((b2 ?? 0) << 8) | (b3 ?? 0);
  const machO = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].map((m) => m | 0);
  if (machO.includes(magic) || magic === 0x7f454c46) return "native";
  if (b0 === 0x4d && b1 === 0x5a) return "native";
  if (b0 !== 0x23 || b1 !== 0x21) return "unknown";
  const firstLine = new TextDecoder().decode(head).slice(2).split("\n")[0] ?? "";
  const words = firstLine.trim().split(/\s+/);
  let interpreter = words[0]?.split("/").at(-1) ?? "";
  if (interpreter === "env") interpreter = words.slice(1).find((w) => !w.startsWith("-")) ?? "";
  return SHELLS.has(interpreter) ? "shellWrapper" : "script";
};

/**
 * Every `name` executable on `PATH`, in order. On Windows each folder offers the native `.exe` (the
 * native installer) before the `.cmd` shim (npm's global install).
 */
export const pathCandidates = (
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
  name = "claude",
): ReadonlyArray<string> => {
  const win = platform === "win32";
  const pathVar = Object.entries(env).find(([k]) => (win ? k.toUpperCase() : k) === "PATH")?.[1];
  const sep = win ? "\\" : "/";
  const names = win ? [`${name}.exe`, `${name}.cmd`] : [name];
  return (pathVar ?? "")
    .split(win ? ";" : ":")
    .filter((dir) => dir !== "")
    .flatMap((dir) => names.map((file) => `${dir.replace(/[/\\]+$/, "")}${sep}${file}`));
};

export interface BinaryFs {
  /** Fails if the path doesn't exist. */
  realpath(path: string): Effect.Effect<string, unknown>;
  readHead(path: string, bytes: number): Effect.Effect<Uint8Array, unknown>;
}

export const nodeFs: BinaryFs = {
  realpath: (path) => Effect.tryPromise(() => realpath(path)),
  readHead: (path, bytes) =>
    Effect.tryPromise(async () => {
      const handle = await open(path, "r");
      try {
        const buffer = new Uint8Array(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    }),
};

/** Resolution failed without attributing the failure to a particular adapter. */
export class BinaryNotFound extends Data.TaggedError("BinaryNotFound")<{
  readonly skipped: ResolvedBinary["skipped"];
  readonly message: string;
}> {}

export interface ResolvedBinary {
  readonly path: string;
  /** Candidates passed over because their headers could not be read or they are shell wrappers. */
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>;
}

/**
 * The first usable candidate, skipping shell wrappers that may inject hooks or session arguments.
 * Interpreter scripts (npm installs) and Windows batch shims are accepted.
 */
export const resolveBinary = Effect.fnUntraced(function* (
  candidates: ReadonlyArray<string>,
  fs: BinaryFs,
) {
  const skipped: Array<{ path: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const real = yield* fs.realpath(candidate).pipe(Effect.option);
    if (Option.isNone(real)) continue;
    if (seen.has(real.value)) continue;
    seen.add(real.value);
    const head = yield* fs.readHead(real.value, 256).pipe(Effect.option);
    if (Option.isNone(head)) {
      skipped.push({ path: real.value, reason: "unreadable" });
      continue;
    }
    if (classifyExecutable(head.value) === "shellWrapper") {
      skipped.push({ path: real.value, reason: "shell wrapper" });
      continue;
    }
    return { path: real.value, skipped } satisfies ResolvedBinary;
  }
  const detail = skipped.length ? ` (skipped: ${skipped.map((s) => s.path).join(", ")})` : "";
  return yield* Effect.fail(
    new BinaryNotFound({ skipped, message: `No executable on the login-shell PATH${detail}` }),
  );
});

/** The first semantic version in a CLI's version output. */
export const parseCliVersion = (output: string): string | undefined =>
  /(\d+\.\d+\.\d+)/.exec(output)?.[1];

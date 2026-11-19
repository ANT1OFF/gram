// The one subprocess primitive. Everything that shells out (git, gh, the PATH probe) goes through
// `runCommand`, which wraps `effect/process` so nothing else imports that unstable module.
//
// A run is scoped: interrupting it (the timeout included) closes the scope, which SIGTERMs the child,
// SIGKILLs it after `FORCE_KILL_AFTER`, and awaits its exit, so an overrun is killed AND reaped
// rather than left as an orphan.

import * as fs from "node:fs";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { batchFileInvocation, isWindowsBatchFile } from "@gram/contracts/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { ProcSpawnError, ProcTimeout, type ProcError } from "./errors.ts";
import { makeCommandWorker } from "./proc-worker-client.ts";
import { TIER_MILLIS } from "./proc-bounds.ts";
import {
  appendGitConfig,
  discoverySignature,
  gitEnvKey,
  type Guard,
  type ConfigEntry,
  guardFor,
  submoduleConfigFiles,
  submoduleGitDirs,
  leadingOptions,
  parseConfigList,
  withGuardArgs,
} from "./repo-config-guard.ts";

export type Tier = "local" | "network" | "slow";

export { TIER_MILLIS } from "./proc-bounds.ts";

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const FORCE_KILL_AFTER = "2 seconds";

export interface RunOptions {
  readonly cwd: string;
  readonly tier?: Tier | undefined;
  /** Overrides `tier`. */
  readonly timeoutMs?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * Inherited variables this picks are left out of the child's env; `env` still applies after.
   * Applied before the command runs anywhere, so it never crosses to the macOS command worker.
   */
  readonly omitEnv?: ((name: string) => boolean) | undefined;
  /** Piped to the child, then closed. Without it stdin is ignored, so a prompt can never wedge. */
  readonly stdin?: string | undefined;
  readonly maxOutputBytes?: number | undefined;
  /**
   * Called with each piece of stdout and stderr as it arrives, decoded, before the cap applies; for
   * showing a long command's progress while it runs. The collected output is unchanged.
   */
  readonly onOutput?: ((text: string) => void) | undefined;
}

export interface ProcOutput {
  /** Exit code; `-1` when the child died from a signal. */
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** A stream passed `maxOutputBytes`; the excess was drained and dropped. */
  readonly truncated: boolean;
}

export interface ProcShape {
  /**
   * Run `bin` to completion. A non-zero exit is a value; a spawn failure or an overrun is a typed
   * error, so a killed child's empty output is never read as an answer.
   */
  readonly run: (
    bin: string,
    args: ReadonlyArray<string>,
    options: RunOptions,
  ) => Effect.Effect<ProcOutput, ProcError>;
}

export class Proc extends Context.Service<Proc, ProcShape>()("@gram/git/Proc") {}

interface Collected {
  readonly chunks: Array<Uint8Array>;
  size: number;
  truncated: boolean;
}

const collect = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  cap: number,
  onOutput: ((text: string) => void) | undefined,
) => {
  // One decoder per stream, so a multi-byte character split across two chunks still decodes.
  const decoder = onOutput === undefined ? undefined : new TextDecoder();
  return Stream.runFold(
    stream,
    (): Collected => ({ chunks: [], size: 0, truncated: false }),
    (acc, chunk) => {
      if (decoder !== undefined) {
        const text = decoder.decode(chunk, { stream: true });
        if (text !== "") onOutput!(text);
      }
      const room = cap - acc.size;
      if (chunk.length <= room) {
        acc.chunks.push(chunk);
        acc.size += chunk.length;
      } else {
        if (room > 0) acc.chunks.push(chunk.subarray(0, room));
        acc.size = cap;
        acc.truncated = true;
      }
      return acc;
    },
  ).pipe(
    Effect.map((acc) => ({
      text: Buffer.concat(acc.chunks).toString("utf8"),
      truncated: acc.truncated,
    })),
  );
};

const encoder = new TextEncoder();

/**
 * The escaped command line as one command with no arguments: Effect's `ChildProcess` refuses
 * arguments beside `shell` (since 4.1.0). Node joined them with spaces into this same line.
 */
const shellLine = (invocation: {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
}): { readonly file: string; readonly args: ReadonlyArray<string> } => ({
  file: [invocation.file, ...invocation.args].join(" "),
  args: [],
});

/** The spawn path behind `Proc.run`, taking the resolved executable and the full child env. */
export const runCommand = (
  spawner: ChildProcessSpawner["Service"],
  exe: string,
  bin: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
  env: Readonly<Record<string, string>>,
): Effect.Effect<ProcOutput, ProcError> => {
  const timeoutMs = options.timeoutMs ?? TIER_MILLIS[options.tier ?? "local"];
  const cap = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  // Node won't spawn a Windows batch file (npm's `claude.cmd`) directly; it goes through `cmd.exe`.
  const batch = process.platform === "win32" && isWindowsBatchFile(exe);
  const invocation = batch ? shellLine(batchFileInvocation(exe, args)) : { file: exe, args };
  const command = ChildProcess.make(invocation.file, invocation.args, {
    cwd: options.cwd,
    env: withGitLongPaths(
      { ...withoutEnv(env, options.omitEnv), ...options.env },
      exe,
      process.platform,
    ),
    extendEnv: false,
    windowsHide: true,
    ...(batch ? { shell: true } : {}),
    stdin: options.stdin === undefined ? "ignore" : Stream.make(encoder.encode(options.stdin)),
    forceKillAfter: FORCE_KILL_AFTER,
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(command);
      const [stdout, stderr, status] = yield* Effect.all(
        [
          collect(handle.stdout, cap, options.onOutput),
          collect(handle.stderr, cap, options.onOutput),
          handle.exitCode.pipe(
            Effect.map((code) => Number(code)),
            Effect.orElseSucceed(() => -1),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return {
        status,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      } satisfies ProcOutput;
    }),
  ).pipe(
    Effect.mapError((error) => new ProcSpawnError({ bin, message: error.message })),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(new ProcTimeout({ bin, message: `${bin} timed out` })),
    }),
  );
};

/**
 * On Windows, resolve a bare name on PATH the way the shell does, trying each `PATHEXT` extension
 * per folder, so npm's `claude.cmd` shim counts; `runCommand` runs batch files through `cmd.exe`.
 * Elsewhere, and for anything already carrying a separator or extension, the name passes through.
 */
export const resolveExecutable = (
  bin: string,
  platform: NodeJS.Platform,
  pathValue: string,
  exists: (path: string) => boolean = fs.existsSync,
  pathExt: string = process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD",
): string => {
  if (platform !== "win32" || /[\\/]/.test(bin) || /\.[A-Za-z0-9]+$/.test(bin)) return bin;
  const extensions = pathExt.split(";").filter((ext) => ext !== "");
  for (const dir of pathValue.split(";")) {
    if (dir === "") continue;
    let end = dir.length;
    while (end > 0 && (dir[end - 1] === "/" || dir[end - 1] === "\\")) end--;
    for (const ext of extensions) {
      const candidate = `${dir.slice(0, end)}\\${bin}${ext.toLowerCase()}`;
      if (exists(candidate)) return candidate;
    }
  }
  return bin;
};

/** `env` without the variables `omit` picks: a plain object, which a worker can be sent. */
export const withoutEnv = (
  env: Readonly<Record<string, string>>,
  omit: ((name: string) => boolean) | undefined,
): Readonly<Record<string, string>> =>
  omit === undefined
    ? env
    : Object.fromEntries(Object.entries(env).filter(([name]) => !omit(name)));

/** The child env: the inherited env, the probed login-shell PATH (Unix), and no terminal prompts. */
export const childEnv = (
  base: Readonly<Record<string, string | undefined>>,
  pathValue: string,
  platform: NodeJS.Platform,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  if (platform !== "win32" && pathValue !== "") env["PATH"] = pathValue;
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
};

const isGitExecutable = (exe: string) => /(?:^|[\\/])git(?:\.exe)?$/i.test(exe);

/**
 * For a git child on Windows, `env` plus `core.longpaths=true` as the next `GIT_CONFIG_*` pair after
 * any already set, so a checkout under `.worktrees/<branch>` can pass the 260-character path limit.
 * Other executables and platforms get `env` as it is.
 */
export const withGitLongPaths = (
  env: Readonly<Record<string, string>>,
  exe: string,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> => {
  if (platform !== "win32" || !isGitExecutable(exe)) return env;
  // Windows env names are case-insensitive, so an inherited count may be spelled any way.
  const countKey =
    Object.keys(env).find((key) => key.toUpperCase() === "GIT_CONFIG_COUNT") ?? "GIT_CONFIG_COUNT";
  const count = Number.parseInt(env[countKey] ?? "", 10);
  const index = Number.isInteger(count) && count > 0 ? count : 0;
  return {
    ...env,
    [countKey]: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "core.longpaths",
    [`GIT_CONFIG_VALUE_${index}`]: "true",
  };
};

// ---------------------------------------------------------------------------------------------
// PATH probe

const PATH_MARK = "__SB_PATH__";
const PATH_PROBE_TIMEOUT_MS = 12_000;

/** The PATH between the probe's markers, ignoring whatever the user's rc files print around it. */
export const parsePathProbe = (stdout: string): string | undefined => {
  const start = stdout.indexOf(PATH_MARK);
  if (start < 0) return undefined;
  const from = start + PATH_MARK.length;
  const end = stdout.indexOf(PATH_MARK, from);
  if (end < 0) return undefined;
  const value = stdout.slice(from, end);
  return value === "" ? undefined : value;
};

/**
 * The login-shell PATH, captured once. A GUI-launched app inherits launchd's minimal PATH, so tools
 * installed under `~/.local/bin` or Homebrew would be invisible. The shell is **interactive** (`-i`)
 * because zsh/bash source `.zshrc`/`.bashrc`, where users extend PATH, only for interactive shells.
 */
export class PathProbe extends Context.Service<
  PathProbe,
  { readonly path: Effect.Effect<string> }
>()("@gram/git/PathProbe") {}

/** The command runner shared by the PATH probe and Proc, including one scoped worker on macOS. */
class CommandRunner extends Context.Service<
  CommandRunner,
  {
    readonly run: (
      exe: string,
      bin: string,
      args: ReadonlyArray<string>,
      options: RunOptions,
      env: Readonly<Record<string, string>>,
    ) => Effect.Effect<ProcOutput, ProcError>;
  }
>()("@gram/git/CommandRunner") {}

const probePath = (run: CommandRunner["Service"]["run"]): Effect.Effect<string> => {
  const fallback = process.env["PATH"] ?? process.env["Path"] ?? "";
  if (process.platform === "win32") return Effect.succeed(fallback);
  const shell = process.env["SHELL"] ?? (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  return run(
    shell,
    shell,
    ["-ilc", `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`],
    { cwd: process.cwd(), timeoutMs: PATH_PROBE_TIMEOUT_MS },
    childEnv(process.env, "", process.platform),
  ).pipe(
    Effect.map((out) => parsePathProbe(out.stdout) ?? fallback),
    Effect.orElseSucceed(() => fallback),
  );
};

export const PlatformLive = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
);

/** Worker entry points use the same runCommand and platform without importing effect/process. */
export const runCommandWithPlatform = (
  exe: string,
  bin: string,
  args: ReadonlyArray<string>,
  options: RunOptions,
  env: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return yield* runCommand(spawner, exe, bin, args, options, env);
  }).pipe(Effect.provide(PlatformLive));

const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    return {
      run: (exe, bin, args, options, env) => runCommand(spawner, exe, bin, args, options, env),
    } satisfies CommandRunner["Service"];
  }),
).pipe(Layer.provide(PlatformLive));

const pathProbeLayer = Layer.effect(
  PathProbe,
  Effect.gen(function* () {
    const runner = yield* CommandRunner;
    const path = yield* Effect.cached(probePath(runner.run));
    return { path };
  }),
);

export const PathProbeLive = pathProbeLayer.pipe(Layer.provide(CommandRunnerLive));

const GUARD_CACHE_LIMIT = 512;

interface CachedGuard {
  readonly signature: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly guard: Guard;
}

/**
 * The repository config guard for git children (`repo-config-guard.ts`): the repository's own
 * program-naming keys read before the call, with git's own options and the call's env, and kept
 * while nothing that decides the repository or its config has changed.
 */
const makeRepoConfigGuard = (runner: CommandRunner["Service"]) => {
  const cache = new Map<string, CachedGuard>();
  return (
    exe: string,
    args: ReadonlyArray<string>,
    options: Omit<RunOptions, "omitEnv">,
    env: Readonly<Record<string, string>>,
  ): Effect.Effect<Guard, ProcError> =>
    Effect.gen(function* () {
      const globals = args.slice(0, leadingOptions(args));
      const key = `${options.cwd}\0${globals.join("\0")}\0${gitEnvKey(env)}`;
      const hit = cache.get(key);
      if (
        hit !== undefined &&
        discoverySignature(options.cwd, hit.gitDir, hit.commonDir) === hit.signature
      )
        return hit.guard;
      const read = (more: ReadonlyArray<string>) =>
        runner.run(exe, "git", [...globals, ...more], { cwd: options.cwd, tier: "local" }, env);
      const dirs = yield* read([
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ]);
      const listing = yield* read(["config", "--list", "--show-scope", "-z"]);
      // A listing that failed or was cut short can't vouch for anything: the call doesn't run.
      if (listing.status !== 0 || listing.truncated)
        return yield* Effect.fail(
          new ProcSpawnError({ bin: "git", message: "couldn't read the repository's git config" }),
        );
      const [gitDir, commonDir] = dirs.stdout.trim().split("\n");
      // A git started inside a submodule reads that one's own config, so it is read here too.
      const nested: Array<ConfigEntry> = [];
      if (dirs.status === 0 && commonDir) {
        const submodules = submoduleGitDirs(commonDir);
        if (submodules === undefined)
          return yield* Effect.fail(
            new ProcSpawnError({ bin: "git", message: "the repository has too many submodules" }),
          );
        for (const file of submodules.flatMap(submoduleConfigFiles)) {
          if (!fs.existsSync(file)) continue;
          const own = yield* read(["config", "--file", file, "--list", "--show-scope", "-z"]);
          if (own.status !== 0 || own.truncated)
            return yield* Effect.fail(
              new ProcSpawnError({ bin: "git", message: "couldn't read a submodule's git config" }),
            );
          for (const entry of parseConfigList(own.stdout))
            nested.push({ ...entry, scope: "local" });
        }
      }
      const guard = guardFor(parseConfigList(listing.stdout), nested);
      // Not a repository (yet), or one with includes: read again next time.
      if (dirs.status === 0 && gitDir && commonDir && !guard.includes && globals.length === 0) {
        if (cache.size >= GUARD_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(key, {
          signature: discoverySignature(options.cwd, gitDir, commonDir),
          gitDir,
          commonDir,
          guard,
        });
      }
      return guard;
    });
};

const makeProc = Effect.gen(function* () {
  const runner = yield* CommandRunner;
  const probe = yield* PathProbe;
  const resolved = new Map<string, string>();
  const repoConfigGuard = makeRepoConfigGuard(runner);
  const run: ProcShape["run"] = (bin, args, options) =>
    Effect.gen(function* () {
      const pathValue = yield* probe.path;
      let exe = resolved.get(bin);
      if (exe === undefined) {
        exe = resolveExecutable(bin, process.platform, pathValue);
        resolved.set(bin, exe);
      }
      // The inherited env is filtered here, as data, so the runner (perhaps a worker) gets no function.
      const { omitEnv, ...rest } = options;
      const base = withoutEnv(childEnv(process.env, pathValue, process.platform), omitEnv);
      if (!isGitExecutable(exe)) return yield* runner.run(exe, bin, args, rest, base);
      const env = { ...base, ...rest.env };
      const guard = yield* repoConfigGuard(exe, args, rest, env);
      return yield* runner.run(
        exe,
        bin,
        withGuardArgs(args, guard),
        { ...rest, env: undefined },
        appendGitConfig(env, guard.pairs),
      );
    });
  return { run };
});

export const ProcLive = Layer.effect(Proc, makeProc).pipe(
  Layer.provide(Layer.mergeAll(PathProbeLive, CommandRunnerLive)),
);

const workerRunnerLive = Layer.effect(
  CommandRunner,
  Effect.map(makeCommandWorker(), (run) => ({ run })),
);

/** The server's login-shell probe shares its command worker on macOS. */
export const PathProbeNonBlockingLive =
  process.platform === "darwin"
    ? pathProbeLayer.pipe(Layer.provide(workerRunnerLive))
    : PathProbeLive;

/** Server commands on macOS use a scoped worker; Linux/Windows retain the direct platform. */
export const ProcNonBlockingLive =
  process.platform === "darwin"
    ? Layer.effect(Proc, makeProc).pipe(
        Layer.provide(Layer.mergeAll(PathProbeNonBlockingLive, workerRunnerLive)),
      )
    : ProcLive;

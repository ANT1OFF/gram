import * as fs from "node:fs";
import * as nodePath from "node:path";
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
  gitlinkPaths,
  nestedGitDir,
  submoduleGitDirs,
  leadingOptions,
  parseConfigList,
  pinnedTransport,
  redirectedBy,
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
  /**
   * A git given this URL in place of a remote's name (`remoteGit`, once the URL was checked) is
   * refused when the repository's own config would send it elsewhere (`redirectedBy`) or names
   * its own TLS certificates, and reaches it over HTTP only as the user set up (`pinnedTransport`),
   * so the URL checked is the URL git reaches, the way the user would.
   */
  readonly pinnedUrl?: string | undefined;
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

const isGhExecutable = (exe: string) => /(?:^|[\\/])gh(?:\.exe)?$/i.test(exe);

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

const NESTED_LIMIT = 64;

const gitlinkedGitDirs = (
  read: (more: ReadonlyArray<string>) => Effect.Effect<ProcOutput, ProcError>,
): Effect.Effect<
  { readonly dirs: ReadonlyArray<string>; readonly dotGits: ReadonlyArray<string> } | undefined,
  ProcError
> =>
  Effect.gen(function* () {
    const top = yield* read(["rev-parse", "--show-toplevel"]);
    if (top.status !== 0 || top.stdout.trim() === "") return { dirs: [], dotGits: [] };
    const found: Array<string> = [];
    const dotGits: Array<string> = [];
    const queue: Array<{ readonly worktree: string; readonly gitDir: string | undefined }> = [
      { worktree: top.stdout.trim(), gitDir: undefined },
    ];
    while (queue.length > 0) {
      const { worktree, gitDir } = queue.shift()!;
      const listing = yield* read([
        "-c",
        "core.fsmonitor=false",
        ...(gitDir === undefined ? [] : ["--git-dir", gitDir, "--work-tree", worktree]),
        "ls-files",
        "--stage",
        "-z",
      ]);
      if (listing.status !== 0 || listing.truncated) return undefined;
      for (const path of gitlinkPaths(listing.stdout)) {
        const at = nodePath.join(worktree, path);
        dotGits.push(nodePath.join(at, ".git"));
        if (dotGits.length > NESTED_LIMIT * 4) return undefined;
        const dir = nestedGitDir(at);
        if (dir === undefined) continue;
        found.push(dir);
        if (found.length > NESTED_LIMIT) return undefined;
        queue.push({ worktree: at, gitDir: dir });
      }
    }
    return { dirs: found, dotGits };
  });

interface CachedGuard {
  readonly signature: string;
  readonly gitDir: string;
  readonly commonDir: string;
  readonly nestedGitDirs: ReadonlyArray<string>;
  readonly gitlinkDotGits: ReadonlyArray<string>;
  readonly guard: Guard;
}

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
        discoverySignature(
          options.cwd,
          hit.gitDir,
          hit.commonDir,
          undefined,
          hit.nestedGitDirs,
          hit.gitlinkDotGits,
        ) === hit.signature
      )
        return hit.guard;
      const listEnv = Object.fromEntries(
        Object.entries(env).filter(([name]) => name.toUpperCase() !== "GIT_CONFIG"),
      );
      const read = (more: ReadonlyArray<string>) =>
        runner.run(exe, "git", [...globals, ...more], { cwd: options.cwd, tier: "local" }, listEnv);
      const dirs = yield* read([
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
      ]);
      const listing = yield* read(["config", "--list", "--show-scope", "-z"]);
      if (listing.status !== 0 || listing.truncated)
        return yield* Effect.fail(
          new ProcSpawnError({ bin: "git", message: "couldn't read the repository's git config" }),
        );
      const [gitDir, commonDir] = dirs.stdout.trim().split("\n");
      const nested: Array<ConfigEntry> = [];
      const nestedDirs: Array<string> = [];
      let dotGits: ReadonlyArray<string> = [];
      if (dirs.status === 0 && commonDir) {
        const modules = submoduleGitDirs(commonDir);
        const linked = yield* gitlinkedGitDirs(read);
        if (modules === undefined || linked === undefined)
          return yield* Effect.fail(
            new ProcSpawnError({ bin: "git", message: "the repository has too many submodules" }),
          );
        dotGits = linked.dotGits;
        const seen = new Set(modules.map((dir) => nodePath.resolve(dir)));
        for (const dir of linked.dirs)
          if (!seen.has(nodePath.resolve(dir))) {
            seen.add(nodePath.resolve(dir));
            nestedDirs.push(dir);
          }
        const submodules = [...modules, ...nestedDirs];
        if (submodules.length > NESTED_LIMIT)
          return yield* Effect.fail(
            new ProcSpawnError({ bin: "git", message: "the repository has too many submodules" }),
          );
        for (const sub of submodules) {
          const own = yield* runner.run(
            exe,
            "git",
            ["--git-dir", sub, "config", "--list", "--show-scope", "-z"],
            { cwd: options.cwd, tier: "local" },
            listEnv,
          );
          if (own.status !== 0 || own.truncated)
            return yield* Effect.fail(
              new ProcSpawnError({ bin: "git", message: "couldn't read a submodule's git config" }),
            );
          for (const entry of parseConfigList(own.stdout))
            if (entry.scope === "local" || entry.scope === "worktree") nested.push(entry);
        }
      }
      const guard = guardFor(parseConfigList(listing.stdout), nested);
      if (dirs.status === 0 && gitDir && commonDir && !guard.includes && globals.length === 0) {
        if (cache.size >= GUARD_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(key, {
          signature: discoverySignature(
            options.cwd,
            gitDir,
            commonDir,
            undefined,
            nestedDirs,
            dotGits,
          ),
          gitDir,
          commonDir,
          nestedGitDirs: nestedDirs,
          gitlinkDotGits: dotGits,
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
      const { omitEnv, pinnedUrl, ...rest } = options;
      const base = withoutEnv(childEnv(process.env, pathValue, process.platform), omitEnv);
      if (isGhExecutable(exe)) {
        const env = { ...base, ...rest.env };
        const gitExe = resolved.get("git") ?? resolveExecutable("git", process.platform, pathValue);
        resolved.set("git", gitExe);
        const guard = yield* repoConfigGuard(gitExe, [], rest, env);
        return yield* runner.run(
          exe,
          bin,
          args,
          { ...rest, env: undefined },
          appendGitConfig(env, guard.pairs),
        );
      }
      if (!isGitExecutable(exe)) return yield* runner.run(exe, bin, args, rest, base);
      const env = { ...base, ...rest.env };
      const guard = yield* repoConfigGuard(exe, args, rest, env);
      if (pinnedUrl !== undefined && redirectedBy(guard, pinnedUrl))
        return yield* Effect.fail(
          new ProcSpawnError({
            bin: "git",
            message:
              "The repository's own git config sends this remote elsewhere, so Gram doesn't reach it.",
          }),
        );
      if (pinnedUrl !== undefined && guard.ownTls === true)
        return yield* Effect.fail(
          new ProcSpawnError({
            bin: "git",
            message:
              "The repository's own git config names the certificates git trusts or presents, so Gram doesn't reach its remote.",
          }),
        );
      const pairs =
        pinnedUrl === undefined
          ? guard.pairs
          : [...guard.pairs, ...pinnedTransport(guard, pinnedUrl, env)];
      return yield* runner.run(
        exe,
        bin,
        withGuardArgs(args, guard),
        { ...rest, env: undefined },
        appendGitConfig(env, pairs),
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

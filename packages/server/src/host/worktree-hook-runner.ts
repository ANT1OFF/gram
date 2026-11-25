import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errnoCode, redactText, SECRET_KEY, type WorktreeHookKind } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { missingCommand, plainLines, signalGroup, stopGroup } from "../git/check-process.ts";
import { redactUrlCredentials } from "./remote-url.ts";
import { type WorktreeHookSource, worktreeHookFingerprint } from "./worktree-hook-source.ts";

export const SETUP_TIMEOUT_MS = 20 * 60_000;
export const RESUME_TIMEOUT_MS = 10_000;
const MAX_LOG_BYTES = 48 * 1024;
const KILL_GRACE_MS = 100;
const REAP_MS = 400;

type HookProcessFailure =
  | "missing-tool"
  | "timeout"
  | "exited"
  | "launch"
  | "cleanup"
  | "interrupted";

interface HookProcessResult {
  readonly durationMs: number;
  readonly log: string;
}

export type WorktreeHookResult = HookProcessResult &
  (
    | { readonly status: "passed" }
    | {
        readonly status: "failed";
        readonly failure: HookProcessFailure;
        readonly reason: string;
        readonly exitCode?: number;
      }
  );

export const sanitizeHookText = (text: string): string =>
  redactText(redactUrlCredentials(plainLines(text).join("\n")));

const BASE_ENV = ["LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "USER", "TMPDIR"];
const PUBLIC_VARIABLE = /^GRAM_HOOK_PUBLIC_[A-Z0-9_]+$/;

export const worktreeHookEnv = (
  checkout: string,
  kind: WorktreeHookKind,
  loginPath: string,
  base: NodeJS.ProcessEnv,
  publicVariables: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const allowed = Object.entries(publicVariables).filter(
    ([name]) => PUBLIC_VARIABLE.test(name) && !SECRET_KEY.test(name),
  );
  const env = Object.fromEntries(allowed);
  for (const name of BASE_ENV) {
    const value = base[name];
    if (value !== undefined) env[name] = value;
  }
  env["HOME"] = base["HOME"] ?? homedir();
  env["PATH"] = loginPath || "/usr/bin:/bin";
  env["GRAM_WORKTREE"] = checkout;
  env[kind === "setup" ? "GRAM_SETUP" : "GRAM_RESUME"] = "1";
  return env;
};

interface HookRunnerOptions {
  readonly loginPath: string;
  readonly approvedFingerprint: string;
  readonly stagingRoot?: string;
  readonly base?: NodeJS.ProcessEnv;
  readonly publicVariables?: Readonly<Record<string, string>>;
  readonly budgetMs?: number;
  readonly interrupted?: (outcome: WorktreeHookResult) => Effect.Effect<void>;
}

type HookCompletion =
  | { readonly kind: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly kind: "spawn"; readonly code: string | undefined }
  | { readonly kind: "timeout" };

const hookFailure = (
  failure: HookProcessFailure,
  reason: string,
  durationMs = 0,
  log = "",
  exitCode?: number,
): WorktreeHookResult => ({
  status: "failed",
  failure,
  reason,
  durationMs,
  log,
  ...(exitCode === undefined ? {} : { exitCode }),
});

const startHook = (bin: string, cwd: string, env: Record<string, string>, timeoutMs: number) => {
  const started = Date.now();
  const child = spawn(bin, [], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const logChunks: Buffer[] = [];
  let keptBytes = 0;
  let truncated = false;
  const remember = (chunk: Buffer) => {
    const room = MAX_LOG_BYTES - keptBytes;
    if (room > 0) {
      const kept = chunk.subarray(0, room);
      logChunks.push(kept);
      keptBytes += kept.length;
    }
    if (chunk.length > room) truncated = true;
  };
  child.stdout.on("data", remember);
  child.stderr.on("data", remember);
  let exited = false;
  let abort: (() => void) | undefined;
  let stopped: Promise<boolean> | undefined;
  const stop = () => {
    if (child.pid === undefined) return Promise.resolve(true);
    const pgid = child.pid;
    return (stopped ??= stopGroup(
      pgid,
      () => (!exited || signalGroup(pgid, 0) ? "ours" : "gone"),
      KILL_GRACE_MS,
      REAP_MS,
    ));
  };
  const complete = new Promise<HookCompletion>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    abort = () => clearTimeout(timer);
    child.once("error", (error) => {
      exited = true;
      resolve({ kind: "spawn", code: errnoCode(error) });
    });
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ kind: "exit", code, signal });
    });
  });
  const closed = new Promise<void>((resolve) => void child.once("close", () => resolve()));
  const cleanup = async () => {
    abort?.();
    const clean = await stop();
    const pipesClosed = clean && (await Promise.race([closed.then(() => true), delay(100, false)]));
    child.stdout.destroy();
    child.stderr.destroy();
    return pipesClosed;
  };

  return {
    complete,
    cleanup,
    duration: () => Date.now() - started,
    log: () => {
      const text = sanitizeHookText(Buffer.concat(logChunks).toString("utf8"));
      return truncated ? `${text.trimEnd()}\n[Hook output truncated.]` : text;
    },
  };
};

const staging = (root: string | undefined): string => {
  if (root === undefined) return mkdtempSync(join(tmpdir(), "gram-worktree-hook-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error("The worktree hook staging directory is not private.");
  return mkdtempSync(join(root, "run-"));
};

/** Executes only the selected committed bytes, with the worktree as cwd and closed stdin. */
export const runWorktreeHook = (
  checkout: string,
  source: WorktreeHookSource,
  options: HookRunnerOptions,
): Effect.Effect<WorktreeHookResult> => {
  if (process.platform === "win32")
    return Effect.succeed(hookFailure("launch", "This machine cannot execute POSIX hooks."));
  if (
    source.fingerprint !== options.approvedFingerprint ||
    worktreeHookFingerprint(source.path, source.script) !== options.approvedFingerprint
  )
    return Effect.succeed(
      hookFailure("launch", "The hook bytes differ from the approved fingerprint."),
    );
  const limit = source.kind === "setup" ? SETUP_TIMEOUT_MS : RESUME_TIMEOUT_MS;
  const budget = Math.min(options.budgetMs ?? limit, limit);
  if (budget <= 0) return Effect.succeed(hookFailure("timeout", "The hook deadline elapsed."));

  return Effect.acquireUseRelease(
    Effect.try(() => staging(options.stagingRoot)),
    (dir) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const running = yield* Effect.try(() => {
            const file = join(dir, source.kind);
            writeFileSync(file, source.script, { mode: 0o700, flag: "wx" });
            const env = worktreeHookEnv(
              checkout,
              source.kind,
              options.loginPath,
              options.base ?? process.env,
              options.publicVariables,
            );
            return startHook(file, checkout, env, budget);
          });
          const complete = yield* restore(Effect.promise(() => running.complete)).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                const clean = yield* Effect.promise(running.cleanup);
                if (options.interrupted === undefined) return;
                yield* options.interrupted(
                  hookFailure(
                    clean ? "interrupted" : "cleanup",
                    clean
                      ? "The hook was interrupted."
                      : "The hook was interrupted and cleanup could not be confirmed.",
                    running.duration(),
                    running.log(),
                  ),
                );
              }),
            ),
          );
          const clean = yield* Effect.promise(running.cleanup);
          const duration = running.duration();
          const log = running.log();
          if (!clean)
            return hookFailure(
              "cleanup",
              "Could not stop the hook's process group.",
              duration,
              log,
            );
          if (complete.kind === "timeout")
            return hookFailure(
              "timeout",
              "The hook exceeded its execution deadline.",
              duration,
              log,
            );
          if (complete.kind === "spawn") {
            if (complete.code === "EACCES" || complete.code === "EPERM")
              return hookFailure(
                "launch",
                "The machine denied execution of the staged hook or its interpreter.",
                duration,
                log,
              );
            return complete.code === "ENOENT" && existsSync(checkout)
              ? hookFailure(
                  "missing-tool",
                  `Hook interpreter ${sanitizeHookText(source.interpreter)} is unavailable.`,
                  duration,
                  log,
                )
              : hookFailure("launch", "Could not start the hook in its worktree.", duration, log);
          }
          if (complete.code === 0) return { status: "passed" as const, durationMs: duration, log };
          const missing = complete.code === 127 ? missingCommand(log) : undefined;
          if (missing !== undefined)
            return hookFailure(
              "missing-tool",
              `Required command ${missing} is unavailable on this machine.`,
              duration,
              log,
              127,
            );
          return hookFailure(
            "exited",
            complete.signal === null
              ? `The hook exited with status ${complete.code}.`
              : `The hook stopped on ${complete.signal}.`,
            duration,
            log,
            complete.code ?? undefined,
          );
        }),
      ),
    (dir) => Effect.try(() => rmSync(dir, { recursive: true, force: true })).pipe(Effect.ignore),
  ).pipe(
    Effect.orElseSucceed(() => hookFailure("launch", "Could not stage the hook for execution.")),
  );
};

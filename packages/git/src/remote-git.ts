import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ProcSpawnError, type ProcError } from "./errors.ts";
import { git, type GitOptions } from "./exec.ts";
import type { Proc, ProcOutput } from "./proc.ts";
import { leadingOptions } from "./repo-config-guard.ts";

/** A guard refused a folder's origin: `message` says why, in words a person can act on. */
export class OriginRefused extends Data.TaggedError("OriginRefused")<{
  readonly message: string;
}> {}

/** Whether git in `dir` may reach that folder's `origin`, run with the caller's `Proc`. */
export type OriginGuard = (dir: string) => Effect.Effect<void, OriginRefused, Proc>;

let guard: OriginGuard | undefined;

/**
 * Asks `next` before each git that reaches a folder's `origin`, for as long as this process runs
 * or until the returned function is called. One guard at a time: a later one replaces it.
 */
export const guardOrigins = (next: OriginGuard): (() => void) => {
  guard = next;
  return () => {
    if (guard === next) guard = undefined;
  };
};

const ALWAYS_REMOTE: Readonly<Record<string, ReadonlySet<string> | true>> = {
  submodule: new Set(["update", "sync", "foreach", "init", "add"]),
  lfs: new Set(["fetch", "pull", "push", "checkout", "fsck", "prune"]),
  remote: new Set(["update", "prune", "show", "set-head"]),
  clone: true,
};

const NAMED_REMOTE = new Set(["fetch", "push", "pull", "ls-remote"]);

/** Whether `args`, the arguments git is given, reach a remote: what `remoteGit` exists for. */
export const reachesRemote = (args: ReadonlyArray<string>): boolean => {
  const at = leadingOptions(args);
  const verb = args[at];
  if (verb === undefined) return false;
  if (NAMED_REMOTE.has(verb)) return true;
  const sub = ALWAYS_REMOTE[verb];
  if (sub === undefined) return false;
  if (sub === true) return true;
  const next = args.slice(at + 1).find((arg) => !arg.startsWith("-"));
  return next !== undefined && sub.has(next);
};

/**
 * Whether `args` reach the folder's `origin`: a fetch, push, pull or ls-remote that names it, or
 * names no remote, which is the default one; `--all` and `--multiple` take it in; a submodule's,
 * LFS's or `remote update` transfer always might. A clone makes a new folder from a URL, whose
 * origin is that URL.
 */
export const reachesOrigin = (args: ReadonlyArray<string>): boolean => {
  const at = leadingOptions(args);
  const verb = args[at];
  if (verb === undefined || !reachesRemote(args) || verb === "clone") return false;
  if (!NAMED_REMOTE.has(verb)) return true;
  const rest = args.slice(at + 1);
  if (rest.includes("--all") || rest.includes("--multiple")) return true;
  const end = rest.indexOf("--");
  const positional =
    end >= 0 ? rest[end + 1] : rest.find((arg) => !arg.startsWith("-") && arg !== "");
  return positional === undefined || positional === "origin";
};

/**
 * The one way Gram's own git reaches a remote: `fetch`, `push`, `pull`, `ls-remote`, `remote
 * update`, a submodule's or LFS's transfer, a clone (`reachesRemote`). Before one that reaches a
 * folder's `origin` starts, the embedder's guard (`guardOrigins`) is asked whether that folder's
 * origin is the repository it should be, since a folder's git config is anyone's to rewrite who
 * works there; without a guard, as on a person's own desktop, git starts as it always did.
 * `gram/remote-git-only` fails the lint on a network git spelled anywhere else. A refusal starts nothing and fails as git that couldn't be started does
 * (`ProcSpawnError`), with the guard's words, so every caller that gives up on a failed fetch or
 * push gives up on this one too.
 */
export const remoteGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
): Effect.Effect<ProcOutput, ProcError, Proc> =>
  Effect.gen(function* () {
    const ask = guard;
    if (ask !== undefined && reachesOrigin(args))
      yield* ask(cwd).pipe(
        Effect.mapError((refused) => new ProcSpawnError({ bin: "git", message: refused.message })),
      );
    return yield* git(cwd, args, options);
  });

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ProcSpawnError, type ProcError } from "./errors.ts";
import { git, type GitOptions } from "./exec.ts";
import type { Proc, ProcOutput } from "./proc.ts";
import { isOptionShaped } from "./ref-format.ts";
import { leadingOptions } from "./repo-config-guard.ts";

/** A guard refused a folder's origin: `message` says why, in words a person can act on. */
export class OriginRefused extends Data.TaggedError("OriginRefused")<{
  readonly message: string;
}> {}

/** Where a guard checked that git in a folder fetches `origin` from and pushes it to. */
export interface OriginUrls {
  readonly fetch: string;
  readonly push: string;
}

/**
 * Whether git in `dir` may reach that folder's `origin`, run with the caller's `Proc`: refused,
 * allowed as it is (nothing), or allowed only to the URLs the guard checked, which git is then
 * given in place of the remote's name (`pinnedArgs`).
 */
export type OriginGuard = (dir: string) => Effect.Effect<OriginUrls | void, OriginRefused, Proc>;

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

const optionsEnd = (rest: ReadonlyArray<string>): number =>
  rest.findIndex((arg) => arg === "--end-of-options" || arg === "--");

const POSITIONAL_AFTER_END = new Set([...NAMED_REMOTE, "clone"]);

/**
 * Why `args` can't go to git as they are, or `undefined`: a fetch, push, pull, ls-remote or clone
 * whose remote, refspec, URL or folder stands before `--end-of-options` (or `--`), where git
 * would read an option, or one after it that is option-shaped all the same. A remote's or ref's
 * name read from a repository could be spelled as an option (`--upload-pack=…`), and git would
 * run what it names; options go before the end of options, spelled `--name=value`.
 */
export const positionalProblem = (args: ReadonlyArray<string>): string | undefined => {
  const at = leadingOptions(args);
  const verb = args[at];
  if (verb === undefined || !POSITIONAL_AFTER_END.has(verb)) return undefined;
  const rest = args.slice(at + 1);
  const end = optionsEnd(rest);
  const options = end < 0 ? rest : rest.slice(0, end);
  if (options.some((arg) => !isOptionShaped(arg)))
    return `Gram gives git ${verb} its remote, refs and paths only after --end-of-options.`;
  if (end >= 0 && rest.slice(end + 1).some(isOptionShaped))
    return `Gram refused a git ${verb} argument that git could read as an option.`;
  return undefined;
};

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
  const end = optionsEnd(rest);
  const positional =
    end >= 0 ? rest[end + 1] : rest.find((arg) => !arg.startsWith("-") && arg !== "");
  return positional === undefined || positional === "origin";
};

const FULL_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

const trackingRefspec = (spec: string): string => {
  const body = spec.startsWith("+") ? spec.slice(1) : spec;
  if (body.includes(":") || FULL_OID.test(body)) return spec;
  if (body.startsWith("refs/") && !body.startsWith("refs/heads/")) return spec;
  const name = body.startsWith("refs/heads/") ? body.slice("refs/heads/".length) : body;
  return `+refs/heads/${name}:refs/remotes/origin/${name}`;
};

/**
 * `args`, which reach `origin` (`reachesOrigin`), with `origin` replaced by the URL the guard
 * checked, so git never reads it again from config an agent can rewrite meanwhile: a fetch's
 * refspecs spelled out as `origin`'s map them, and a fetch naming none takes every branch.
 * `undefined` for git that can't be given a URL so: no remote named, `--all`, a pull, or a
 * submodule's, LFS's or `remote` transfer.
 */
export const pinnedArgs = (
  args: ReadonlyArray<string>,
  urls: OriginUrls,
): { readonly args: ReadonlyArray<string>; readonly url: string } | undefined => {
  const at = leadingOptions(args);
  const verb = args[at];
  if (verb !== "fetch" && verb !== "push" && verb !== "ls-remote") return undefined;
  const rest = args.slice(at + 1);
  if (rest.includes("--all") || rest.includes("--multiple")) return undefined;
  const end = optionsEnd(rest);
  const index = end >= 0 ? end + 1 : rest.findIndex((arg) => !arg.startsWith("-") && arg !== "");
  if (index < 0 || index >= rest.length || rest[index] !== "origin") return undefined;
  const url = verb === "push" ? urls.push : urls.fetch;
  const specs = rest.slice(index + 1);
  const refspecs =
    verb !== "fetch"
      ? specs
      : specs.length === 0
        ? ["+refs/heads/*:refs/remotes/origin/*"]
        : specs.map(trackingRefspec);
  return { args: [...args.slice(0, at + 1), ...rest.slice(0, index), url, ...refspecs], url };
};

/**
 * The one way Gram's own git reaches a remote: `fetch`, `push`, `pull`, `ls-remote`, `remote
 * update`, a submodule's or LFS's transfer, a clone (`reachesRemote`). Before one that reaches a
 * folder's `origin` starts, the embedder's guard (`guardOrigins`) is asked whether that folder's
 * origin is the repository it should be, since a folder's git config is anyone's to rewrite who
 * works there; without a guard, as on a person's own desktop, git starts as it always did. Where
 * the guard checked the URLs, git is given the checked one in place of `origin` (`pinnedArgs`),
 * and refused if the repository's own config would send that URL elsewhere (`pinnedUrl`).
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
    const problem = positionalProblem(args);
    if (problem !== undefined) return yield* new ProcSpawnError({ bin: "git", message: problem });
    const ask = guard;
    if (ask === undefined || !reachesOrigin(args)) return yield* git(cwd, args, options);
    const urls = yield* ask(cwd).pipe(
      Effect.mapError((refused) => new ProcSpawnError({ bin: "git", message: refused.message })),
    );
    if (urls === undefined) return yield* git(cwd, args, options);
    const pinned = pinnedArgs(args, urls);
    if (pinned === undefined)
      return yield* new ProcSpawnError({
        bin: "git",
        message: "Gram reaches a checked origin only by a fetch, push or ls-remote that names it.",
      });
    return yield* git(cwd, pinned.args, { ...options, pinnedUrl: pinned.url });
  });

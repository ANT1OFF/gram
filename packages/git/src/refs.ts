// Remote-tracking ref queries shared by worktree creation, the rebase signal and the diff fallback.

import * as nodePath from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProcError } from "./errors.ts";
import { branchExists, git, gitFailMsg } from "./exec.ts";
import { fromGitPath, mtimeMs } from "./paths.ts";
import type { Proc } from "./proc.ts";

/** Default-branch candidates, in preference order. */
export const DEFAULT_BASES = ["master", "main"] as const;

/**
 * The repo's default remote-tracking branch. `fetch: true` refreshes `origin/master` then
 * `origin/main` (network tier) and deliberately ignores `origin/HEAD`; `fetch: false` prefers
 * `origin/HEAD`, so a develop-default repo isn't measured against a lingering master. Both fall back
 * to whichever of master/main exists locally.
 */
export const baseRef = (
  cwd: string,
  fetch: boolean,
): Effect.Effect<string | undefined, never, Proc> =>
  Effect.gen(function* () {
    if (fetch) {
      for (const branch of DEFAULT_BASES) {
        // A new worktree fetches its base with nobody at the keyboard: an orchestrator spawns
        // workers unattended, and with expired credentials Git for Windows would otherwise raise
        // the credential manager's window and hold the fetch until the network tier kills it.
        const out = yield* git(
          cwd,
          ["-c", "credential.interactive=false", "fetch", "--quiet", "origin", branch],
          { tier: "network" },
        ).pipe(Effect.option);
        if (Option.isSome(out) && out.value.status === 0) return `origin/${branch}`;
      }
    } else {
      const head = yield* git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).pipe(
        Effect.option,
      );
      if (Option.isSome(head) && head.value.status === 0 && head.value.stdout.trim() !== "") {
        return head.value.stdout.trim();
      }
    }
    for (const branch of DEFAULT_BASES) {
      if (yield* branchExists(cwd, `origin/${branch}`)) return `origin/${branch}`;
    }
    return undefined;
  });

/** No network: `origin/HEAD`, else `origin/master`/`origin/main`. */
export const localBaseRef = (cwd: string) => baseRef(cwd, false);

/** Refresh and return the ref a new branch should start from; `undefined` means "current HEAD". */
export const originBaseRef = (repoTop: string) => baseRef(repoTop, true);

/**
 * `origin/*` branch names for the base picker, newest commit first. `origin/HEAD` is filtered on the
 * FULL refname: git shortens that symref to the bare `origin`, which a short-name check misses.
 */
export const listBaseRefs = (repoTop: string): Effect.Effect<Array<string>, never, Proc> =>
  git(repoTop, [
    "for-each-ref",
    "--format=%(refname)%09%(refname:short)",
    "--sort=-committerdate",
    "refs/remotes/origin/",
  ]).pipe(
    Effect.map((out) =>
      out.status !== 0
        ? []
        : out.stdout.split("\n").flatMap((line) => {
            const [full, short] = line.trim().split("\t");
            return short && full !== "refs/remotes/origin/HEAD" ? [short] : [];
          }),
    ),
    Effect.orElseSucceed(() => []),
  );

/**
 * Tips of `refs/remotes/origin/<name>` for several names in one spawn, keyed by bare name; absent
 * refs are missing. A timeout stays an error so a stalled disk can't read as "never pushed".
 */
export const originTips = (
  cwd: string,
  names: ReadonlyArray<string>,
): Effect.Effect<Map<string, string>, ProcError, Proc> => {
  if (names.length === 0) return Effect.succeed(new Map());
  return git(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)",
    ...names.map((name) => `refs/remotes/origin/${name}`),
  ]).pipe(
    Effect.map((out) => {
      const tips = new Map<string, string>();
      for (const line of out.stdout.split("\n")) {
        const [short, oid] = line.trimEnd().split("\t");
        if (short?.startsWith("origin/") && oid) tips.set(short.slice("origin/".length), oid);
      }
      return tips;
    }),
  );
};

/** The current branch and its `origin/` upstream (such as `origin/feat`), from local config only. */
export const currentUpstream = (
  cwd: string,
): Effect.Effect<
  { readonly branch: string | undefined; readonly ref: string | undefined },
  never,
  Proc
> =>
  Effect.gen(function* () {
    const head = yield* git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(Effect.option);
    const name = Option.isSome(head) && head.value.status === 0 ? head.value.stdout.trim() : "";
    if (name === "" || name === "HEAD") return { branch: undefined, ref: undefined };
    const upstream = yield* git(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]).pipe(Effect.option);
    const ref =
      Option.isSome(upstream) && upstream.value.status === 0 ? upstream.value.stdout.trim() : "";
    return { branch: name, ref: ref.startsWith("origin/") ? ref : undefined };
  });

/** Fetching a base branch failed: no origin, no such branch, auth or network. */
export class FetchFailed extends Data.TaggedError("FetchFailed")<{ readonly message: string }> {}

/** Epoch ms of the repo's last fetch (`FETCH_HEAD`), or `undefined` when it has never fetched. */
export const lastFetchedAt = (repoTop: string): Effect.Effect<number | undefined, never, Proc> =>
  git(repoTop, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.map((out) => {
      if (out.status !== 0) return undefined;
      const at = mtimeMs(nodePath.join(fromGitPath(out.stdout.trim()), "FETCH_HEAD"));
      return at > 0 ? at : undefined;
    }),
    Effect.orElseSucceed(() => undefined),
  );

const tipOf = (repoTop: string, ref: string) =>
  git(repoTop, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout.trim() : undefined)),
    Effect.orElseSucceed(() => undefined),
  );

/** `git fetch origin <name>` for `origin/<name>` (network tier), reporting the commits it added. */
export const fetchOriginBranch = (
  repoTop: string,
  ref: string,
): Effect.Effect<
  { readonly newCommits: number; readonly fetchedAt: number | undefined },
  FetchFailed,
  Proc
> =>
  Effect.gen(function* () {
    const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : "";
    if (name === "") return yield* new FetchFailed({ message: `${ref} is not an origin branch` });
    const before = yield* tipOf(repoTop, ref);
    const out = yield* git(repoTop, ["fetch", "--quiet", "origin", name], { tier: "network" }).pipe(
      Effect.mapError((e) => new FetchFailed({ message: e.message })),
    );
    if (out.status !== 0) {
      return yield* new FetchFailed({ message: gitFailMsg(out, "git fetch failed") });
    }
    const after = yield* tipOf(repoTop, ref);
    let newCommits = 0;
    if (after !== undefined && after !== before) {
      const range = before === undefined ? after : `${before}..${after}`;
      const count = yield* git(repoTop, ["rev-list", "--count", range]).pipe(Effect.option);
      if (Option.isSome(count) && count.value.status === 0) {
        newCommits = Number.parseInt(count.value.stdout.trim(), 10) || 0;
      }
    }
    return { newCommits, fetchedAt: yield* lastFetchedAt(repoTop) };
  });

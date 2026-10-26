// The service that computes and pushes git state: the local tier on demand, a full snapshot with the
// network tier (PR badge, throttled background fetch, rebase signal against the PR base), and the
// watcher stream.

import type { GitState, PrStatus } from "@gram/contracts";
import * as fs from "node:fs";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ProcError } from "./errors.ts";
import { git } from "./exec.ts";
import { carryRebaseTier, fetchRedundant, localGitState, withPr } from "./git-state.ts";
import { originOwnerRepo, Pr, prLookupReason } from "./pr.ts";
import { samePathKey } from "./paths.ts";
import { Proc } from "./proc.ts";
import { localBaseRef, originTips } from "./refs.ts";
import { cachedRepoRoots } from "./repo-facts.ts";
import { watchGitState, type GitStateChange, type WatchOptions } from "./watch.ts";
import { workElsewhere } from "./work-elsewhere.ts";

/** A repo is eligible for the background fetch at most this often. */
export const FETCH_THROTTLE_MS = 45_000;

/** Records "now" and returns true when `key` had no fetch within `throttleMs`. */
export const fetchDue = (
  lastFetch: Map<string, number>,
  key: string,
  now: number,
  throttleMs: number,
): boolean => {
  const last = lastFetch.get(key);
  if (last !== undefined && now - last < throttleMs) return false;
  lastFetch.set(key, now);
  return true;
};

export interface SnapshotOptions {
  /** Also refresh the network tier: PR lookup and the throttled fetch. */
  readonly remote: boolean;
  /** The last published state; its PR and rebase tier are carried when a refresh can't complete. */
  readonly previous?: GitState | undefined;
  /**
   * Measure the rebase tier (behind / ahead, merge-tree, upstream) and fetch for it. `false` carries
   * `previous`'s tier instead, for a checkout no one can see; without `previous` it's measured anyway.
   */
  readonly rebase?: boolean;
  /**
   * Scan the other worktrees for uncommitted work, a `git status` in each; defaults to `remote`.
   * Otherwise the last answer is carried while this checkout stays clean on the same branch.
   */
  readonly scanElsewhere?: boolean;
  /** How many of those `git status` calls a scan runs at a time. */
  readonly scanConcurrency?: number;
  /**
   * Nothing has changed the checkout since its last local read (its watcher saw nothing), so that
   * read stands in for the three `git` runs of a new one. Read anyway when there is none to reuse.
   */
  readonly reuseLocal?: boolean;
}

export class GitStateRuntime extends Context.Service<
  GitStateRuntime,
  {
    readonly local: (cwd: string) => Effect.Effect<GitState, ProcError>;
    readonly snapshot: (
      cwd: string,
      options: SnapshotOptions,
    ) => Effect.Effect<GitState, ProcError>;
    readonly watch: (
      paths: ReadonlyArray<string>,
      options?: WatchOptions,
    ) => Stream.Stream<GitStateChange>;
    /**
     * Whether the checkout's folder is there: false only when it is definitely gone, so a folder
     * that can't be read counts as present and its git says why.
     */
    readonly present: (cwd: string) => Effect.Effect<boolean>;
  }
>()("@gram/git/GitStateRuntime") {}

/**
 * Refresh the refs the rebase signal reads: the branch and its base only, throttled per repo, and
 * skipped when GraphQL already proved both local tips current. Never pops a credential UI.
 */
const maybeFetch = (
  cwd: string,
  branch: string | undefined,
  pr: PrStatus | undefined,
  lastFetch: Map<string, number>,
) =>
  Effect.gen(function* () {
    if (branch === undefined) return false;
    const roots = yield* cachedRepoRoots(cwd);
    if (roots === undefined) return false;
    const last = lastFetch.get(roots.common);
    if (last !== undefined && Date.now() - last < FETCH_THROTTLE_MS) return false;
    if (pr?.baseRef !== undefined && pr.baseRefOid !== undefined) {
      const tips = yield* originTips(
        cwd,
        pr.headRefOid === undefined ? [pr.baseRef] : [pr.baseRef, branch],
      );
      if (fetchRedundant(tips.get(pr.baseRef), pr.baseRefOid, tips.get(branch), pr.headRefOid))
        return false;
    }
    if (!fetchDue(lastFetch, roots.common, Date.now(), FETCH_THROTTLE_MS)) return false;
    const base = pr?.baseRef ?? (yield* localBaseRef(cwd))?.replace(/^origin\//, "");
    const refs = base === undefined || base === branch ? [branch] : [branch, base];
    yield* git(cwd, ["-c", "credential.interactive=false", "fetch", "--quiet", "origin", ...refs], {
      tier: "network",
    });
    return true;
  }).pipe(Effect.orElseSucceed(() => false));

export const GitStateRuntimeLive = Layer.effect(
  GitStateRuntime,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const pr = yield* Pr;
    const provide = Effect.provideService(Proc, proc);
    const lastFetch = new Map<string, number>();
    /**
     * Per checkout, by `samePathKey`: its latest local read, from a snapshot or its watcher, for
     * `reuseLocal`. Keyed as the publisher keys its watchers, so threads that spell one checkout two
     * ways share the read its one watcher keeps current.
     */
    const lastLocal = new Map<string, GitState>();

    const readLocal = (cwd: string) =>
      localGitState(cwd).pipe(
        Effect.tap((state) => Effect.sync(() => lastLocal.set(samePathKey(cwd), state))),
      );

    const snapshot = (cwd: string, options: SnapshotOptions) =>
      provide(
        Effect.gen(function* () {
          const kept = options.reuseLocal === true ? lastLocal.get(samePathKey(cwd)) : undefined;
          const local = kept ?? (yield* readLocal(cwd));
          if (!local.repo) return local;
          const origin = yield* originOwnerRepo(cwd);
          const state: GitState = origin === undefined ? local : { ...local, origin };
          const carriedPr = options.previous?.pr;
          // A failed lookup keeps the carried badge, marked stale from the first failure on.
          const nextPr = options.remote
            ? yield* pr.status(cwd, undefined, { branch: local.branch, head: local.head }).pipe(
                Effect.catchTag("PrLookupError", (error) =>
                  Effect.map(Clock.currentTimeMillis, (now): PrStatus | undefined =>
                    carriedPr === undefined
                      ? undefined
                      : {
                          ...carriedPr,
                          stale: {
                            reason: prLookupReason(error.message),
                            since: carriedPr.stale?.since ?? now,
                          },
                        },
                  ),
                ),
              )
            : carriedPr;
          const previous = options.previous;
          const measure = options.rebase !== false || previous === undefined;
          if (options.remote && measure) yield* maybeFetch(cwd, state.branch, nextPr, lastFetch);
          const next = measure
            ? yield* withPr(cwd, state, nextPr, previous)
            : carryRebaseTier(nextPr === undefined ? state : { ...state, pr: nextPr }, previous);
          // The cue for a PR on another worktree is found by the sweep; keep it while there's no own PR.
          const badged: GitState =
            next.pr === undefined && previous?.prElsewhere !== undefined
              ? { ...next, prElsewhere: previous.prElsewhere }
              : next;
          // Between scans the last answer is kept while this checkout stays clean on its branch.
          const carried = previous?.workElsewhere;
          const elsewhere =
            (options.scanElsewhere ?? options.remote)
              ? yield* workElsewhere(cwd, badged, { concurrency: options.scanConcurrency ?? 1 })
              : carried !== undefined &&
                  badged.changedFiles === 0 &&
                  badged.branch === previous?.branch
                ? carried
                : undefined;
          return elsewhere === undefined ? badged : { ...badged, workElsewhere: elsewhere };
        }),
      );

    return {
      local: (cwd) => provide(readLocal(cwd)),
      snapshot,
      present: (cwd) =>
        Effect.sync(() => {
          try {
            return fs.statSync(cwd, { throwIfNoEntry: false }) !== undefined;
          } catch {
            // EACCES and the like: there, but unreadable.
            return true;
          }
        }),
      watch: (paths, options) =>
        watchGitState(paths, options).pipe(
          Stream.tap((change) =>
            Effect.sync(() => lastLocal.set(samePathKey(change.path), change.state)),
          ),
          Stream.provideService(Proc, proc),
        ),
    };
  }),
);

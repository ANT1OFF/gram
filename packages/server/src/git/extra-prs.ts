// A thread's PR bindings (`boundPr` and `extraPrs`) and the rows the strip hides, as pure edits
// shared by the RPC handlers, the agent's PR tools and babysit mode so they refuse the same things.
// Every edit is a function of the thread the store's update transaction reads (`applyPrEdit`): an
// update computed from an earlier read can write a main PR back over a promotion that landed in
// between.

import {
  MAX_EXTRA_PRS,
  MAX_HIDDEN_PRS,
  narrowHiddenPrs,
  samePr,
  type BoundPr,
  type HiddenPr,
  type MonitorMark,
  type PrStatus,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import { repoFromPrUrl } from "@gram/git";
import * as Effect from "effect/Effect";

export type PrRef = Pick<BoundPr, "repo" | "number">;

/** Whether `badge` is `pr`'s: numbers are local to a repository, so the same one elsewhere isn't. */
export const isBadgeOf = (
  badge: Pick<PrStatus, "number" | "url">,
  pr: { readonly repo: string; readonly number: number },
): boolean =>
  badge.number === pr.number && repoFromPrUrl(badge.url)?.toLowerCase() === pr.repo.toLowerCase();

/** The edited thread, or why the edit was refused. */
export type PrEdit =
  | { readonly thread: Thread; readonly refused?: never }
  | { readonly refused: string; readonly thread?: never };

const label = (ref: PrRef) => `${ref.repo}#${ref.number}`;

/** Replacing the main PR must not silently erase an armed merge, including a held one. */
export const rebindBlocker = (thread: Thread, ref: PrRef): string | undefined =>
  thread.boundPr?.mergeWhenReady !== undefined && !samePr(thread.boundPr, ref)
    ? `merge_when_ready is armed on ${label(thread.boundPr)}; wait for it to merge or explicitly disable it before rebinding. Use pr_bind add: true to follow another PR meanwhile.`
    : undefined;

/**
 * A binding whose dependencies its orchestrator declared (`depends_on`) can't be dropped or replaced
 * by its own thread: that would drop them, and with them the merge order they hold.
 */
export const dependencyBlocker = (thread: Thread): string | undefined => {
  const declared = (thread.boundPr?.dependsOn ?? []).filter(
    (each) => each.setBy === "orchestrator",
  );
  if (thread.boundPr === undefined || declared.length === 0) return undefined;
  return `Your orchestrator declared that ${label(thread.boundPr)} depends on ${declared.map(label).join(", ")}; only it can drop that (depends_on remove: true), so this binding stays.`;
};

export const validPrRef = (ref: PrRef): boolean =>
  /^[\w.-]+\/[\w.-]+$/.test(ref.repo) && Number.isSafeInteger(ref.number) && ref.number > 0;

/** `thread` with its extras replaced; an empty list leaves the key off, as stored threads have it. */
const withExtras = (thread: Thread, extras: ReadonlyArray<BoundPr>): Thread => {
  const { extraPrs, ...rest } = thread;
  void extraPrs;
  return extras.length === 0 ? rest : { ...rest, extraPrs: extras };
};

export const addExtraPr = (thread: Thread, ref: PrRef, monitor: boolean): PrEdit => {
  const extras = thread.extraPrs ?? [];
  if (thread.boundPr !== undefined && samePr(thread.boundPr, ref)) {
    return { refused: `${label(ref)} is already this thread's pull request` };
  }
  if (extras.some((extra) => samePr(extra, ref))) {
    return { refused: `${label(ref)} is already followed by this thread` };
  }
  if (extras.length >= MAX_EXTRA_PRS) {
    return { refused: `a thread follows at most ${MAX_EXTRA_PRS} extra pull requests` };
  }
  return {
    thread: withExtras(thread, [...extras, { repo: ref.repo, number: ref.number, monitor }]),
  };
};

/** Unfollowing a PR the thread doesn't follow changes nothing. */
export const removeExtraPr = (thread: Thread, ref: PrRef): Thread =>
  withExtras(
    thread,
    (thread.extraPrs ?? []).filter((extra) => !samePr(extra, ref)),
  );

const MARK_KEYS = [
  "head",
  "ci",
  "checks",
  "verdict",
  "mergeState",
  "reviewId",
  "reviewsRead",
  "humanReviews",
] as const satisfies ReadonlyArray<keyof MonitorMark>;

/** Whether two monitor marks say the same. */
const sameMark = (a: MonitorMark | undefined, b: MonitorMark | undefined): boolean =>
  MARK_KEYS.every((key) => JSON.stringify(a?.[key]) === JSON.stringify(b?.[key]));

/** The monitors' mark on the PR `ref` names, main or extra; `undefined` when it has none or isn't followed. */
export const markOf = (thread: Thread, ref: PrRef): MonitorMark | undefined =>
  [...(thread.boundPr === undefined ? [] : [thread.boundPr]), ...(thread.extraPrs ?? [])].find(
    (pr) => samePr(pr, ref),
  )?.seen;

/**
 * `thread` with the monitors' mark on the PR `ref` names set to `mark`: the same thread when it
 * already says that, or the thread follows no such PR, so a caller can tell there's nothing to write.
 */
export const withMonitorMark = (thread: Thread, ref: PrRef, mark: MonitorMark): Thread => {
  const marked = (pr: BoundPr): BoundPr =>
    samePr(pr, ref) && !sameMark(pr.seen, mark) ? { ...pr, seen: mark } : pr;
  const boundPr = thread.boundPr === undefined ? undefined : marked(thread.boundPr);
  const extras = thread.extraPrs?.map(marked);
  if (boundPr === thread.boundPr && (extras ?? []).every((pr, i) => pr === thread.extraPrs?.[i]))
    return thread;
  return {
    ...thread,
    ...(boundPr === undefined ? {} : { boundPr }),
    ...(extras === undefined ? {} : { extraPrs: extras }),
  };
};

/** `bound` without the monitors' mark. */
export const unmarked = (bound: BoundPr): BoundPr => {
  const { seen: _, ...rest } = bound;
  return rest;
};

/** A binding's mark with only what the monitors still on wrote: the CI monitor's, the review monitor's. */
const prunedPr = (pr: BoundPr, main: boolean): BoundPr => {
  const seen = pr.seen;
  if (seen === undefined) return pr;
  const { ci, head, ...review } = seen;
  const reviewing = main && pr.reviewMonitor === true;
  // With the review monitor on, the CI monitor stands aside, so what it saw goes stale.
  const ciOn = pr.monitor && !reviewing && ci !== undefined;
  const reviewOn = reviewing && Object.keys(review).length > 0;
  if (!ciOn && !reviewOn) return unmarked(pr);
  const kept: MonitorMark = {
    ...(head === undefined ? {} : { head }),
    ...(ciOn ? { ci } : {}),
    ...(reviewOn ? review : {}),
  };
  return sameMark(kept, seen) ? pr : { ...pr, seen: kept };
};

/**
 * `thread` with each binding's mark kept only for the monitors still on: one turned off and on
 * again starts from a baseline, not from what it saw before it stopped looking. The same thread
 * when there is nothing to take out.
 */
export const prunedMarks = (thread: Thread): Thread => {
  const boundPr = thread.boundPr === undefined ? undefined : prunedPr(thread.boundPr, true);
  const extras = thread.extraPrs?.map((pr) => prunedPr(pr, false));
  if (boundPr === thread.boundPr && (extras ?? []).every((pr, i) => pr === thread.extraPrs?.[i]))
    return thread;
  return {
    ...thread,
    ...(boundPr === undefined ? {} : { boundPr }),
    ...(extras === undefined ? {} : { extraPrs: extras }),
  };
};

/**
 * `thread` with `boundPr` as its main PR. A PR has one row: if the thread followed it as an extra,
 * that entry goes, since the main binding now covers it. (`normalizeThreadPrs` in the store is the
 * backstop for writers that don't come through here.)
 */
export const bindMainPr = (thread: Thread, boundPr: BoundPr): Thread => ({
  ...removeExtraPr(thread, boundPr),
  boundPr,
});

export const setExtraPrMonitor = (thread: Thread, ref: PrRef, monitor: boolean): PrEdit => {
  const extras = thread.extraPrs ?? [];
  if (!extras.some((extra) => samePr(extra, ref))) {
    return { refused: `${label(ref)} isn't followed by this thread` };
  }
  return {
    thread: withExtras(
      thread,
      extras.map((extra) => (samePr(extra, ref) ? { ...extra, monitor } : extra)),
    ),
  };
};

/**
 * Swaps an extra PR with `boundPr`. The old primary keeps its CI watch as an extra but not its review
 * monitor, which only `boundPr` has.
 */
export const promoteExtraPr = (thread: Thread, ref: PrRef): PrEdit => {
  const extras = thread.extraPrs ?? [];
  const promoted = extras.find((extra) => samePr(extra, ref));
  if (promoted === undefined) return { refused: `${label(ref)} isn't followed by this thread` };
  const blocked = rebindBlocker(thread, ref) ?? dependencyBlocker(thread);
  if (blocked !== undefined) return { refused: blocked };
  if (thread.babysit !== undefined) {
    return { refused: "Babysit mode is tied to the current pull request; turn it off first." };
  }
  const demoted: ReadonlyArray<BoundPr> =
    thread.boundPr === undefined
      ? []
      : [
          {
            repo: thread.boundPr.repo,
            number: thread.boundPr.number,
            monitor: thread.boundPr.monitor,
          },
        ];
  const rest = extras.filter((extra) => !samePr(extra, ref));
  return { thread: { ...withExtras(thread, [...demoted, ...rest]), boundPr: promoted } };
};

/**
 * `thread` with `pr`'s row out of the strip: an earlier entry for it is replaced and moves last, and
 * past `MAX_HIDDEN_PRS` the oldest is forgotten. No binding changes.
 */
export const hidePr = (thread: Thread, pr: HiddenPr): Thread => ({
  ...thread,
  hiddenPrs: [...(thread.hiddenPrs ?? []).filter((hidden) => !samePr(hidden, pr)), pr].slice(
    -MAX_HIDDEN_PRS,
  ),
});

export const showHiddenPrs = (thread: Thread): Thread => {
  const { hiddenPrs, ...rest } = thread;
  void hiddenPrs;
  return rest;
};

/** `thread` with its hidden PRs brought up to `badges` (`narrowHiddenPrs`); itself when none moved. */
export const narrowThreadHiddenPrs = (thread: Thread, badges: ReadonlyArray<PrStatus>): Thread => {
  const hiddenPrs =
    thread.hiddenPrs === undefined ? undefined : narrowHiddenPrs(thread.hiddenPrs, badges);
  return hiddenPrs === undefined ? thread : { ...thread, hiddenPrs };
};

/**
 * Runs `edit` on the thread as the store's update transaction reads it, so two edits in flight can't
 * overwrite each other and a refusal is judged on the row that would be written, not on an earlier
 * read. A refused edit writes the thread back unchanged.
 */
export const applyPrEdit = <E, R>(
  updateThread: (threadId: ThreadId, f: (thread: Thread) => Thread) => Effect.Effect<Thread, E, R>,
  threadId: ThreadId,
  edit: (thread: Thread) => PrEdit,
): Effect.Effect<{ readonly thread: Thread; readonly refused: string | undefined }, E, R> =>
  Effect.suspend(() => {
    let refused: string | undefined;
    return updateThread(threadId, (current) => {
      const result = edit(current);
      refused = result.refused;
      return result.thread ?? current;
    }).pipe(Effect.map((thread) => ({ thread, refused })));
  });

/** Changes the main PR's fields from the row being written; refused when the thread has none. */
export const editMainPr =
  (change: (boundPr: BoundPr) => BoundPr) =>
  (thread: Thread): PrEdit =>
    thread.boundPr === undefined
      ? { refused: "no pull request is bound to this thread" }
      : { thread: { ...thread, boundPr: change(thread.boundPr) } };

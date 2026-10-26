import type { PrStatus, ThreadId } from "@gram/contracts";
import { repoFromPrUrl } from "@gram/git";
import type { PrRef } from "./extra-prs.ts";

/** A PR a thread waits on without being bound to it (`GitStatePublisher.watchPrs`). */
export interface PrWatch extends PrRef {
  /** Whose sweeps look it up; an archived thread's watches wait for it to come back. */
  readonly threadId: ThreadId;
  /** Read its reviews too, for a verdict or the bot's rounds, while the allowance affords them. */
  readonly reviews?: boolean | undefined;
}

const keyOf = (ref: PrRef) => `${ref.repo.toLowerCase()}#${ref.number}`;

/** One lookup per PR, with reviews if any of its owners wants them. */
const combine = (watches: Iterable<PrWatch>): Map<string, PrWatch> => {
  const combined = new Map<string, PrWatch>();
  for (const watch of watches) {
    const key = keyOf(watch);
    combined.set(key, {
      ...watch,
      reviews: combined.get(key)?.reviews === true || watch.reviews === true,
    });
  }
  return combined;
};

/**
 * Owns the publisher's PR watches and their last badges. Owner replacement rebuilds the lookup
 * indexes synchronously: a removed owner cannot leave a thread polling or retain an orphan badge.
 * Network effects and observer delivery stay with the publisher.
 */
export const makePrWatches = () => {
  const owners = new Map<string, ReadonlyArray<PrWatch>>();
  const badges = new Map<string, PrStatus>();
  let byThread = new Map<ThreadId, Map<string, PrWatch>>();
  let keys = new Set<string>();

  const forThread = (threadId: ThreadId): ReadonlyArray<PrWatch> => [
    ...(byThread.get(threadId)?.values() ?? []),
  ];

  return {
    replace: (owner: string, watches: ReadonlyArray<PrWatch>): void => {
      if (watches.length === 0) owners.delete(owner);
      else owners.set(owner, watches);
      const grouped = new Map<ThreadId, Array<PrWatch>>();
      for (const owned of owners.values()) {
        for (const watch of owned) {
          const group = grouped.get(watch.threadId) ?? [];
          group.push(watch);
          grouped.set(watch.threadId, group);
        }
      }
      byThread = new Map([...grouped].map(([threadId, group]) => [threadId, combine(group)]));
      keys = new Set([...byThread.values()].flatMap((group) => [...group.keys()]));
      for (const key of badges.keys()) if (!keys.has(key)) badges.delete(key);
    },
    forThread,
    forThreads: (threadIds: ReadonlyArray<ThreadId>): ReadonlyArray<PrWatch> => [
      ...combine(threadIds.flatMap(forThread)).values(),
    ],
    has: (ref: PrRef): boolean => keys.has(keyOf(ref)),
    badge: (ref: PrRef): PrStatus | undefined => badges.get(keyOf(ref)),
    /** A direct lookup can be read before a watch is installed; replacement prunes it normally. */
    remember: (ref: PrRef, badge: PrStatus): void => {
      badges.set(keyOf(ref), badge);
    },
    /**
     * Records a fresh watched badge and returns it only when observers need telling. A lookup
     * without reviews preserves the last read reviews on the same head, so a verdict isn't lost.
     */
    note: (badge: PrStatus): PrStatus | undefined => {
      if (badge.stale !== undefined || keys.size === 0) return undefined;
      const repo = repoFromPrUrl(badge.url);
      if (repo === undefined) return undefined;
      const key = keyOf({ repo, number: badge.number });
      if (!keys.has(key)) return undefined;
      const last = badges.get(key);
      const kept =
        badge.reviewUnread === true &&
        last?.review !== undefined &&
        last.reviewUnread !== true &&
        last.headRefOid === badge.headRefOid
          ? (() => {
              const { reviewUnread: _, ...read } = badge;
              return { ...read, review: last.review };
            })()
          : badge;
      if (last !== undefined && JSON.stringify(last) === JSON.stringify(kept)) return undefined;
      badges.set(key, kept);
      return kept;
    },
  };
};

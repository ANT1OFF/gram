import { waitIsKept, type PrStatus, type Thread, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { isBadgeOf } from "../git/extra-prs.ts";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";

type Badge = Pick<PrStatus, "number" | "url" | "state">;

/**
 * Why archiving `thread` now would cut it off from what it waits on, or `undefined`. An archived
 * thread isn't woken by its checks or its review (the publisher leaves parked threads out), so a
 * worker archived with a pull request open, or a monitor on, waits forever. That holds for each PR
 * it follows: its main one (`badge`, the publisher's for the PR it acts on) and every extra
 * (`extraBadges`). A badge counts only for the PR it names, since a rebind can leave the previous
 * binding's for a moment and numbers are local to a repository; a monitored PR whose state isn't
 * known is held, and one known to be merged or closed waits on nothing.
 */
export const archiveHold = (
  thread: Pick<Thread, "boundPr" | "extraPrs" | "babysit">,
  badge: Badge | undefined,
  extraBadges: ReadonlyArray<Badge> = [],
): string | undefined => {
  if (thread.babysit?.phase === "watching") return "it is babysitting its pull request";
  const bound = thread.boundPr;
  const followed = [
    ...(bound === undefined
      ? badge === undefined
        ? []
        : [{ label: `#${badge.number}`, badge, monitored: false }]
      : [
          {
            label: `${bound.repo}#${bound.number}`,
            badge: badge !== undefined && isBadgeOf(badge, bound) ? badge : undefined,
            monitored: bound.monitor || bound.reviewMonitor === true,
          },
        ]),
    ...(thread.extraPrs ?? []).map((extra) => ({
      label: `${extra.repo}#${extra.number}`,
      badge: extraBadges.find((each) => isBadgeOf(each, extra)),
      monitored: extra.monitor,
    })),
  ];
  for (const pr of followed) {
    if (pr.badge?.state === "OPEN") return `its pull request ${pr.label} is open`;
  }
  for (const pr of followed) {
    if (pr.monitored && pr.badge?.state !== "MERGED" && pr.badge?.state !== "CLOSED") {
      return `it is monitoring pull request ${pr.label}`;
    }
  }
  return undefined;
};

/**
 * What `archive_thread` adds to its answer when the thread it archived leaves items open on the
 * user's Waiting on you, so its orchestrator withdraws or keeps them; nothing when it leaves none.
 */
export const waitsLeftBy = (store: Pick<ThreadStoreShape, "listWaits">, threadId: ThreadId) =>
  Effect.map(store.listWaits(threadId), (items) => {
    const open = items.filter(waitIsKept);
    if (open.length === 0) return {};
    return {
      openWaits: open.map((item) => ({ id: item.id, kind: item.kind, title: item.title })),
      note: `It still has ${open.length === 1 ? "1 item" : `${open.length} items`} on the user's Waiting on you. Withdraw with resolve_wait (this threadId) what no longer waits on them, or keep it.`,
    };
  });

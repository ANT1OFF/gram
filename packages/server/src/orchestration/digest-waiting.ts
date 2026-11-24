import {
  DIGEST_WAITING_LISTED,
  waitEndingOf,
  waitIsKept,
  type DigestVariant,
  type DigestWaiting,
  type DigestWaitingStale,
  type Thread,
  type ThreadId,
  type WaitItem,
  type WaitKind,
} from "@gram/contracts";

/**
 * Whether what `thread` added to Waiting on you likely no longer waits on the user: it is
 * archived, or a merge completed its pull request. The orchestrator's own thread never is.
 */
export const waitsStaleIn = (
  thread: Pick<Thread, "parked" | "settledMerge" | "role">,
): DigestWaitingStale | undefined =>
  thread.role === "orchestrator"
    ? undefined
    : thread.parked
      ? "archived"
      : (thread.settledMerge?.merged.length ?? 0) > 0
        ? "merged"
        : undefined;

/** One thread's items for `digestWaiting`, with its title and whether it is likely done with. */
export interface DigestWaitingThread {
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<WaitItem>;
  /** Its title, which the digest names an item's thread by. */
  readonly title?: string | undefined;
  /** Archived, or its pull request merged: what it added likely no longer waits on the user. */
  readonly stale?: DigestWaitingStale | undefined;
}

/**
 * What waits on the user across an orchestrator's workspace, every thread in it, for its digest:
 * the open items counted by kind with the oldest's age, named on a `boot` (a session
 * that starts fresh, a handoff's among them, remembers none of them) and otherwise those of a
 * `stale` thread, which the orchestrator should withdraw or keep, and since `since`, the digest
 * the orchestrator last took, the titles the user marked done, what they dismissed without doing
 * it, and what a worker withdrew itself (`orchestrator`, the digest's own thread, withdrew its own
 * and its workers' knowingly). `undefined` when there is nothing to say. `threads` holds each
 * thread's items, open and resolved, oldest first. A helper's suggestion isn't the user's until
 * kept, so it is neither open nor done when dismissed or lapsed; what the helper resolved from the
 * user's own words counts as done by them.
 */
export const digestWaiting = (input: {
  readonly variant: DigestVariant;
  readonly threads: ReadonlyArray<DigestWaitingThread>;
  readonly now: number;
  readonly since: number | undefined;
  readonly orchestrator?: ThreadId | undefined;
}): DigestWaiting | undefined => {
  const open = input.threads
    .flatMap((thread) =>
      thread.items.filter(waitIsKept).map((item) => ({ threadId: thread.threadId, thread, item })),
    )
    .toSorted((a, b) => a.item.createdAt - b.item.createdAt);
  const stale = open.filter(({ thread }) => thread.stale !== undefined);
  const since = input.since;
  const ended =
    since === undefined
      ? []
      : input.threads
          .flatMap(({ threadId, items }) => items.map((item) => ({ threadId, item })))
          .filter(
            ({ item }) =>
              item.suggested !== true && item.resolvedAt !== undefined && item.resolvedAt >= since,
          )
          .toSorted((a, b) => a.item.resolvedAt! - b.item.resolvedAt!);
  const resolved = ended
    .filter(
      ({ item }) =>
        (item.resolvedBy === "user" || item.resolvedBy === "helper") &&
        waitEndingOf(item) === "done",
    )
    .map(({ item }) => item.title);
  const endedAs = (entries: typeof ended) =>
    entries.slice(-DIGEST_WAITING_LISTED).map(({ threadId, item }) => ({
      threadId,
      id: item.id,
      title: item.title,
      ...(item.note === undefined ? {} : { note: item.note }),
    }));
  const dismissed = endedAs(
    ended.filter(({ item }) => item.resolvedBy === "user" && waitEndingOf(item) === "dismissed"),
  );
  const withdrawn = endedAs(
    ended.filter(
      ({ threadId, item }) =>
        item.resolvedBy === "agent" &&
        waitEndingOf(item) === "withdrawn" &&
        threadId !== input.orchestrator &&
        item.resolverThread === undefined,
    ),
  );
  if (
    open.length === 0 &&
    resolved.length === 0 &&
    dismissed.length === 0 &&
    withdrawn.length === 0
  ) {
    return undefined;
  }
  const kinds = new Map<WaitKind, number>();
  for (const { item } of open) kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
  const minutes = (at: number) => Math.max(0, Math.floor((input.now - at) / 60_000));
  const oldest = open[0]?.item.createdAt;
  const named = input.variant === "boot" ? open : stale;
  return {
    open: open.length,
    kinds: [...kinds].map(([kind, count]) => ({ kind, count })),
    ...(oldest === undefined ? {} : { oldestMin: minutes(oldest) }),
    ...(stale.length === 0 ? {} : { stale: stale.length }),
    ...(named.length > 0
      ? {
          items: named.slice(0, DIGEST_WAITING_LISTED).map(({ threadId, thread, item }) => ({
            threadId,
            ...(thread.title === undefined ? {} : { thread: thread.title }),
            id: item.id,
            kind: item.kind,
            title: item.title,
            ageMin: minutes(item.createdAt),
            ...(thread.stale === undefined ? {} : { stale: thread.stale }),
          })),
        }
      : {}),
    ...(resolved.length === 0 ? {} : { resolved: resolved.slice(-DIGEST_WAITING_LISTED) }),
    ...(dismissed.length === 0 ? {} : { dismissed }),
    ...(withdrawn.length === 0 ? {} : { withdrawn }),
  };
};

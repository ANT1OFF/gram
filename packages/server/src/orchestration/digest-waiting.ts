import {
  DIGEST_WAITING_LISTED,
  waitEndingOf,
  waitIsKept,
  type DigestVariant,
  type DigestWaiting,
  type ThreadId,
  type WaitItem,
  type WaitKind,
} from "@gram/contracts";

/**
 * What waits on the user across an orchestrator and its workers, for its digest: the
 * open items counted by kind with the oldest's age, named on a `boot` (a session
 * that starts fresh, a handoff's among them, remembers none of them), and since `since`, the digest
 * the orchestrator last took, the titles the user marked done, what they dismissed without doing
 * it, and what a worker withdrew itself (`orchestrator`, the digest's own thread, withdrew its own
 * and its workers' knowingly). `undefined` when there is nothing to say. `threads` holds each
 * thread's items, open and resolved, oldest first. A helper's suggestion isn't the user's until
 * kept, so it is neither open nor done when dismissed or lapsed; what the helper resolved from the
 * user's own words counts as done by them.
 */
export const digestWaiting = (input: {
  readonly variant: DigestVariant;
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly items: ReadonlyArray<WaitItem>;
  }>;
  readonly now: number;
  readonly since: number | undefined;
  readonly orchestrator?: ThreadId | undefined;
}): DigestWaiting | undefined => {
  const open = input.threads
    .flatMap(({ threadId, items }) => items.filter(waitIsKept).map((item) => ({ threadId, item })))
    .toSorted((a, b) => a.item.createdAt - b.item.createdAt);
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
  return {
    open: open.length,
    kinds: [...kinds].map(([kind, count]) => ({ kind, count })),
    ...(oldest === undefined ? {} : { oldestMin: minutes(oldest) }),
    ...(input.variant === "boot" && open.length > 0
      ? {
          items: open.slice(0, DIGEST_WAITING_LISTED).map(({ threadId, item }) => ({
            threadId,
            id: item.id,
            kind: item.kind,
            title: item.title,
            ageMin: minutes(item.createdAt),
          })),
        }
      : {}),
    ...(resolved.length === 0 ? {} : { resolved: resolved.slice(-DIGEST_WAITING_LISTED) }),
    ...(dismissed.length === 0 ? {} : { dismissed }),
    ...(withdrawn.length === 0 ? {} : { withdrawn }),
  };
};

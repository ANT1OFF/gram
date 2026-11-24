import type { ThreadId, WaitEnding, WaitItem, WaitResolver } from "@gram/contracts";

/** Who resolved a Waiting on you item, when, how it ended and what they said of it. */
export interface WaitResolution {
  readonly by: WaitResolver;
  readonly at: number;
  readonly note?: string | undefined;
  /** Absent is `done`. */
  readonly ending?: WaitEnding | undefined;
  /**
   * The agent's thread, when another than the item's own: its orchestrator. The item's own agent
   * hasn't heard of it then, so it is news to it.
   */
  readonly thread?: ThreadId | undefined;
}

/**
 * `item` as `resolution` leaves it, an open one resolved or a resolved one reopened with
 * `undefined`, and its `told_at` then: the resolution's time when the item's own agent resolved it,
 * `null` when a reopening undoes what the agent was told, else `undefined` to leave it. `told` is
 * its `told_at` now. Every change but reopening an open item moves its revision on.
 */
export const resolvedWait = (
  item: WaitItem,
  resolution: WaitResolution | undefined,
  told: number | null,
): { readonly next: WaitItem; readonly toldAt: number | null | undefined } => {
  const {
    resolvedAt: _at,
    resolvedBy: _by,
    note: _note,
    ending: _ending,
    resolverThread: _thread,
    ...rest
  } = item;
  const open: WaitItem =
    item.resolvedAt === undefined && resolution === undefined
      ? rest
      : { ...rest, revision: (item.revision ?? 0) + 1 };
  if (resolution === undefined) {
    return {
      next: open,
      toldAt:
        item.resolvedAt !== undefined && told !== null && told >= item.resolvedAt
          ? null
          : undefined,
    };
  }
  return {
    next: {
      ...open,
      resolvedAt: resolution.at,
      resolvedBy: resolution.by,
      ...(resolution.note === undefined ? {} : { note: resolution.note }),
      ...(resolution.ending === undefined || resolution.ending === "done"
        ? {}
        : { ending: resolution.ending }),
      ...(resolution.thread === undefined ? {} : { resolverThread: resolution.thread }),
    },
    toldAt:
      resolution.by === "agent" && resolution.thread === undefined ? resolution.at : undefined,
  };
};

/** Which of a thread's stored items a read answers: open, `all` kept, or only the `deleted` ones. */
export type WaitRows = "open" | "all" | "deleted";

/**
 * `items` as a read of `which` answers them: deleted ones (`WaitItem.deletedAt`) only for
 * `deleted`, and never otherwise.
 */
export const waitRowsOf =
  (which: WaitRows) =>
  (items: ReadonlyArray<WaitItem>): ReadonlyArray<WaitItem> =>
    items.filter((item) => (item.deletedAt !== undefined) === (which === "deleted"));

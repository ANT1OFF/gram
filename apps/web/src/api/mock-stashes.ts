import {
  DRAFT_STASH_LIMIT,
  type Attachment,
  type DraftStash,
  type StashId,
  type ThreadId,
} from "@gram/contracts";

const STORAGE_KEY = "gram.mock.draftStashes";

const notFound = (stashId: StashId) =>
  Object.assign(new Error("That stashed draft is gone"), {
    _tag: "NotFound",
    entity: "stash",
    id: stashId,
  });

/**
 * The mock's stashed drafts per thread, newest first. With `persist` they're kept in `localStorage`,
 * so a reload finds them like the server's table does; tests leave it off so runs don't leak.
 */
export function createMockStashes(persist: boolean) {
  const storage = persist ? globalThis.localStorage : undefined;
  let stashes: DraftStash[] = [];
  try {
    stashes = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "[]") as DraftStash[];
  } catch {
    stashes = [];
  }
  const save = () => storage?.setItem(STORAGE_KEY, JSON.stringify(stashes));

  return {
    list: (threadId: ThreadId): readonly DraftStash[] =>
      stashes.filter((stash) => stash.threadId === threadId),
    /** Like the server, an id already stored returns that stash, or refuses another thread's. */
    add: (
      threadId: ThreadId,
      text: string,
      attachments: readonly Attachment[],
      id = crypto.randomUUID() as StashId,
    ): DraftStash => {
      const existing = stashes.find((s) => s.id === id);
      if (existing) {
        if (existing.threadId !== threadId) throw notFound(id);
        return existing;
      }
      const stash: DraftStash = {
        id,
        threadId,
        text,
        attachments: [...attachments],
        createdAt: Date.now(),
      };
      const others = stashes.filter((s) => s.threadId !== threadId);
      const own = [stash, ...stashes.filter((s) => s.threadId === threadId)];
      stashes = [...own.slice(0, DRAFT_STASH_LIMIT), ...others];
      save();
      return stash;
    },
    take: (threadId: ThreadId, stashId: StashId): DraftStash => {
      const stash = stashes.find((s) => s.id === stashId && s.threadId === threadId);
      if (!stash) throw notFound(stashId);
      stashes = stashes.filter((s) => s !== stash);
      save();
      return stash;
    },
  };
}

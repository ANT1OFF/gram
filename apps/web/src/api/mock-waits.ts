import {
  fenceWaitNote,
  HELPER_RESOLVE_UNDO_MS,
  MAX_OPEN_WAITS,
  waitData,
  waitIsKept,
  waitIsOpen,
  waitNoteText,
  waitTitleOf,
  type MessageId,
  type ThreadId,
  type WaitId,
  type WaitItem,
  type WaitKind,
} from "@gram/contracts";

import type { MockWorld } from "./mock-world";
import type { WaitsApi } from "./waits/types";

/** What an agent's `wait_on_user` call says, as `simulateWaitOnUser` takes it. */
export interface MockWaitInput {
  readonly kind: WaitKind;
  readonly title: string;
  readonly body?: string;
  readonly copy?: string;
  readonly link?: string;
}

const chip = (item: WaitItem) => ({
  type: "data-wait" as const,
  id: item.id,
  data: waitData(item),
});

const stateOf = (item: WaitItem) => (waitIsOpen(item) ? "open" : "done");

const tooMany = () => new Error("InvalidState: too many items wait on the user");

/**
 * Waiting on you as the server keeps it: every thread's items, open and resolved, each anchored by
 * a `data-wait` chip in the transcript, and what the agent last heard of each, for the note the
 * next message carries (`takeNote`, as the server's `draftNote` and `heard`). Specs add items with
 * `simulateWaitOnUser`, as an agent's `wait_on_user` would.
 */
export function createWaitsMock(world: MockWorld) {
  const items = new Map<ThreadId, WaitItem[]>();
  /** Whether the agent last heard of an item as open or done; absent when it never heard of it. */
  const heard = new Map<WaitId, "open" | "done">();

  const publish = (threadId: ThreadId) => {
    const all = items.get(threadId) ?? [];
    const since = Date.now() - HELPER_RESOLVE_UNDO_MS;
    world.setWaits(
      threadId,
      all.filter(waitIsOpen),
      all
        .filter(
          (item) =>
            item.resolvedBy === "helper" && item.suggested !== true && item.resolvedAt! >= since,
        )
        .toReversed(),
    );
  };
  const kept = (threadId: ThreadId) => (items.get(threadId) ?? []).filter(waitIsKept).length;
  const update = (threadId: ThreadId, id: WaitId, f: (item: WaitItem) => WaitItem) => {
    const all = items.get(threadId) ?? [];
    const index = all.findIndex((item) => item.id === id);
    if (index === -1) throw new Error(`NotFound: wait ${id}`);
    const after = f(all[index]!);
    items.set(threadId, all.with(index, after));
    publish(threadId);
    return after;
  };

  const api = {
    resolveWait: async (threadId: ThreadId, id: WaitId, undo?: boolean) => {
      world.summary(threadId);
      await world.delay(30);
      const all = items.get(threadId) ?? [];
      const index = all.findIndex((item) => item.id === id);
      const before = all[index];
      if (before === undefined) throw new Error(`NotFound: wait ${id}`);
      const { resolvedAt: _at, resolvedBy: _by, note: _note, ...open } = before;
      const after: WaitItem =
        undo === true
          ? open
          : waitIsOpen(before)
            ? { ...before, resolvedAt: Date.now(), resolvedBy: "user" }
            : before;
      if (after === before) return before;
      if (undo === true && before.suggested !== true && kept(threadId) >= MAX_OPEN_WAITS) {
        throw tooMany();
      }
      items.set(threadId, all.with(index, after));
      publish(threadId);
      if (after.messageId !== undefined && after.suggested !== true) {
        world.putDataPart(threadId, chip(after), after.messageId);
      }
      return after;
    },
    keepWait: async (threadId: ThreadId, id: WaitId) => {
      world.summary(threadId);
      await world.delay(30);
      const before = (items.get(threadId) ?? []).find((item) => item.id === id);
      if (before?.suggested !== true || !waitIsOpen(before)) {
        throw new Error(`NotFound: no open suggestion ${id}`);
      }
      if (kept(threadId) >= MAX_OPEN_WAITS) throw tooMany();
      const after = update(threadId, id, (item) => {
        const { suggested: _, ...rest } = item;
        return rest;
      });
      if (after.messageId !== undefined) world.putDataPart(threadId, chip(after), after.messageId);
      return after;
    },
    addWait: async (
      threadId: ThreadId,
      messageId: MessageId,
      options: { readonly kind?: WaitKind; readonly title?: string } = {},
    ) => {
      await world.delay(30);
      const message = world.messages(threadId).find((m) => m.id === messageId);
      if (message === undefined) throw new Error(`NotFound: message ${messageId}`);
      if (kept(threadId) >= MAX_OPEN_WAITS) throw tooMany();
      const title =
        options.title ??
        waitTitleOf(message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n"));
      if (title === undefined) throw new Error("InvalidState: the message has no text");
      const item: WaitItem = {
        id: `w-${world.ids()}` as WaitId,
        kind: options.kind ?? "draft",
        title,
        source: "user",
        createdAt: Date.now(),
        messageId,
      };
      items.set(threadId, [...(items.get(threadId) ?? []), item]);
      world.putDataPart(threadId, chip(item), messageId);
      publish(threadId);
      return item;
    },
    listWaits: async (threadId: ThreadId, state: "open" | "all" = "open") => {
      world.summary(threadId);
      await world.delay(30);
      const all = items.get(threadId) ?? [];
      return state === "all" ? all : all.filter(waitIsOpen);
    },
  } satisfies WaitsApi;

  return {
    api,
    controls: {
      /** Dev and e2e hook: the helper suggests an item from the thread's last reply. */
      simulateHelperSuggestion: (threadId: ThreadId, input: MockWaitInput): WaitItem => {
        const item: WaitItem = {
          id: `w-${world.ids()}` as WaitId,
          kind: input.kind,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.copy === undefined ? {} : { copy: input.copy }),
          ...(input.link === undefined ? {} : { link: input.link }),
          source: "helper",
          createdAt: Date.now(),
          suggested: true,
        };
        items.set(threadId, [...(items.get(threadId) ?? []), item]);
        publish(threadId);
        return item;
      },
      /** Dev and e2e hook: the helper read the user's "sent" as resolving `id`. */
      simulateHelperResolve: (threadId: ThreadId, id: WaitId): WaitItem => {
        const after = update(threadId, id, (item) => ({
          ...item,
          resolvedAt: Date.now(),
          resolvedBy: "helper",
        }));
        if (after.messageId !== undefined) {
          world.putDataPart(threadId, chip(after), after.messageId);
        }
        return after;
      },
      /** Dev and e2e hook: the thread's agent calls `wait_on_user`. */
      simulateWaitOnUser: (threadId: ThreadId, input: MockWaitInput): WaitItem => {
        if (kept(threadId) >= MAX_OPEN_WAITS) throw tooMany();
        const drawn: WaitItem = {
          id: `w-${world.ids()}` as WaitId,
          kind: input.kind,
          title: input.title,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.copy === undefined ? {} : { copy: input.copy }),
          ...(input.link === undefined ? {} : { link: input.link }),
          source: "agent",
          createdAt: Date.now(),
        };
        const item: WaitItem = {
          ...drawn,
          messageId: world.putDataPart(threadId, chip(drawn)) as MessageId,
        };
        items.set(threadId, [...(items.get(threadId) ?? []), item]);
        heard.set(item.id, "open");
        publish(threadId);
        return item;
      },
    },
    /**
     * The fenced note the thread's next message carries, as the server's `draftNote` makes it,
     * heard at once. The helper's suggestions are left out until kept.
     */
    takeNote(threadId: ThreadId): string | undefined {
      const all = (items.get(threadId) ?? []).filter((item) => item.suggested !== true);
      const news = all.filter((item) => heard.get(item.id) !== stateOf(item));
      const note = waitNoteText(news, all.filter(waitIsOpen));
      if (note === undefined) return undefined;
      for (const item of news) heard.set(item.id, stateOf(item));
      return fenceWaitNote(note);
    },
  };
}

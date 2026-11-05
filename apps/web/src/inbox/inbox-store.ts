import type { WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

import type { NeedsYouCategory } from "@/orchestration/needs-you-items";
import { useDerivedAsks } from "@/orchestration/needs-you-store";
import { useViewStore } from "@/views/view-store";

// The Inbox's own state: whether it is open, the item it shows, the category its strip picked and
// whether it lists what is put away for Later. What it lists is `useDerivedAsks`'s Needs you list,
// which every count in the window reads too; nothing here is a second copy of it. No React.

interface InboxState {
  readonly open: boolean;
  /**
   * The item the detail pane shows, by key: kept while the Inbox is closed, so it opens where it
   * was left, and what ⌘⇧U steps on from.
   */
  readonly selected: string | undefined;
  readonly category: NeedsYouCategory;
  /** Whether it lists what is put away for Later instead. */
  readonly later: boolean;
  /** Whether it last closed for a thread it opened, which then keeps focus. */
  readonly leftForThread: boolean;
  select(key: string | undefined): void;
  setCategory(category: NeedsYouCategory): void;
  setLater(later: boolean): void;
  close(): void;
  /** Closes it for a thread it opens: focus stays with that thread. */
  leave(): void;
}

export const useInboxStore = create<InboxState>()((set) => ({
  open: false,
  selected: undefined,
  category: "all",
  later: false,
  leftForThread: false,
  select: (selected) => set({ selected }),
  setCategory: (category) => set({ category }),
  setLater: (later) => set({ later }),
  close: () => set({ open: false }),
  leave: () => set({ open: false, leftForThread: true }),
}));

/** Where `showInbox` opens: an item by key, or a workspace's first item. */
export interface InboxTarget {
  /** A Needs you item's key (`NeedsYouItem.key`), such as `ask:<ask key>`. */
  readonly key?: string | undefined;
  /** The workspace whose first item it opens on, when `key` isn't listed. */
  readonly workspaceId?: WorkspaceId | undefined;
}

/**
 * Opens the Inbox, on `target` when it is listed; otherwise where it was left. A pick of a target
 * shows every category, so the item is never filtered out of sight.
 */
export const showInbox = (target: InboxTarget = {}) => {
  useViewStore.getState().setQuiet(false);
  const { items } = useDerivedAsks.getState().needsYou;
  const byKey = target.key === undefined ? undefined : items.find((i) => i.key === target.key);
  const inWorkspace =
    target.workspaceId === undefined
      ? undefined
      : items.find((item) => item.workspaceId === target.workspaceId);
  const item = byKey ?? inWorkspace;
  useInboxStore.setState({
    open: true,
    leftForThread: false,
    later: false,
    ...(item === undefined ? {} : { selected: item.key, category: "all" as const }),
  });
};

/** Opens the Inbox on the ask `askKey` (`Ask.key`): a notification's Open, a Board line's chip. */
export const showInboxAsk = (askKey: string) => showInbox({ key: `ask:${askKey}` });

/** Opens the Inbox where it was left, or closes it: the title bar's button, the pill and ⌘⇧I. */
export const toggleInbox = () => {
  if (useInboxStore.getState().open) useInboxStore.getState().close();
  else showInbox();
};

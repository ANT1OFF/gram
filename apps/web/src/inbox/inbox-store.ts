import type { WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

import {
  newestAsk,
  newestOfKind,
  sectionOf,
  type NeedsYouCategory,
  type NeedsYouSectionKey,
} from "@/orchestration/needs-you-items";
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
  /**
   * The kind of the item last shown, so a plain open whose item is gone lands on the newest of the
   * same kind rather than the list's first.
   */
  readonly lastKind: NeedsYouSectionKey | undefined;
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
  lastKind: undefined,
  later: false,
  leftForThread: false,
  select: (selected) => {
    const item = useDerivedAsks.getState().needsYou.items.find((each) => each.key === selected);
    set(item === undefined ? { selected } : { selected, lastKind: sectionOf(item) });
  },
  setCategory: (category) => set({ category }),
  setLater: (later) => set({ later }),
  close: () => set({ open: false }),
  leave: () => set({ open: false, leftForThread: true }),
}));

/** Where `showInbox` opens: an item by key, or what the user came for. */
export interface InboxTarget {
  /** A Needs you item's key (`NeedsYouItem.key`), such as `ask:<ask key>`. */
  readonly key?: string | undefined;
  /**
   * The workspace whose newest ask it opens on, when `key` isn't listed; with nothing there, the
   * newest ask anywhere, as `ask` does.
   */
  readonly workspaceId?: WorkspaceId | undefined;
  /** Came from a needs-you count: open on the newest ask (`newestAsk`), not the first error. */
  readonly ask?: boolean | undefined;
}

/**
 * Opens the Inbox. On `target` when it is listed: its key, else the workspace's newest ask, else
 * (for a workspace or a count) the newest ask anywhere. A pick of a target shows every category,
 * so the item is never filtered out of sight. A plain open (the title bar's button, ⌘⇧I) opens
 * where it was left, or, when that item is gone, on the newest of the kind last looked at.
 */
export const showInbox = (target: InboxTarget = {}) => {
  useViewStore.getState().setQuiet(false);
  const { items } = useDerivedAsks.getState().needsYou;
  const byKey = target.key === undefined ? undefined : items.find((i) => i.key === target.key);
  const inWorkspace =
    target.workspaceId === undefined
      ? undefined
      : newestAsk(items.filter((item) => item.workspaceId === target.workspaceId));
  const cameFor = target.ask === true || target.workspaceId !== undefined;
  const item = byKey ?? inWorkspace ?? (cameFor ? newestAsk(items) : undefined);
  const base = { open: true, leftForThread: false, later: false } as const;
  if (item !== undefined) {
    useInboxStore.setState({
      ...base,
      selected: item.key,
      category: "all",
      lastKind: sectionOf(item),
    });
    return;
  }
  const { selected, lastKind, category } = useInboxStore.getState();
  const kept = items.some((each) => each.key === selected);
  const remembered = kept
    ? undefined
    : ((lastKind === undefined ? undefined : newestOfKind(items, lastKind)) ?? newestAsk(items));
  if (remembered === undefined) {
    useInboxStore.setState(base);
    return;
  }
  // The strip's pick stays unless it would hide the item it opens on.
  const shows = category === "all" || category === sectionOf(remembered);
  useInboxStore.setState({
    ...base,
    selected: remembered.key,
    ...(shows ? {} : { category: "all" as const }),
  });
};

/** Opens the Inbox on the ask `askKey` (`Ask.key`): a notification's Open, a Board line's chip. */
export const showInboxAsk = (askKey: string) => showInbox({ key: `ask:${askKey}` });

/** Opens the Inbox where it was left, or closes it: the title bar's button, the pill and ⌘⇧I. */
export const toggleInbox = () => {
  if (useInboxStore.getState().open) useInboxStore.getState().close();
  else showInbox();
};

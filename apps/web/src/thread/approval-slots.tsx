import type { ThreadId } from "@gram/contracts";
import { createContext, use, useCallback, useState, type ReactNode } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

import { useApprovalReceipts } from "./approval-receipt";
import { useAwaitingTools } from "./awaiting-tools";

// Where a thread's approval card sits: under the tool row that waits on it. The row leaves a slot,
// by its call id, and the thread's request cards (request-cards.tsx) move the card's element into
// it, so the card is drawn in the transcript right under the call it decides. The card itself stays
// where it always was in the component tree, above the composer: its shortcuts, its "Always allow
// this rule…" preview and an answer in flight survive the row scrolling out of the transcript's
// window, and a card whose row isn't drawn is shown above the composer instead, as before.

interface SlotsState {
  /** The slot each drawn row left, by tool call id. */
  readonly slots: ReadonlyMap<string, HTMLElement>;
  register(toolCallId: string, element: HTMLElement): void;
  unregister(toolCallId: string, element: HTMLElement): void;
}

interface Slots {
  readonly threadId: ThreadId;
  readonly store: StoreApi<SlotsState>;
}

const createSlots = () =>
  createStore<SlotsState>()((set) => ({
    slots: new Map(),
    register: (toolCallId, element) =>
      set((s) => {
        if (s.slots.get(toolCallId) === element) return s;
        const slots = new Map(s.slots);
        slots.set(toolCallId, element);
        return { slots };
      }),
    unregister: (toolCallId, element) =>
      set((s) => {
        if (s.slots.get(toolCallId) !== element) return s;
        const slots = new Map(s.slots);
        slots.delete(toolCallId);
        return { slots };
      }),
  }));

const SlotsContext = createContext<Slots | undefined>(undefined);

/**
 * Whether rows inside may leave a slot: not inside a closed run, whose line leaves the slot for
 * the call it hides.
 */
const SlotsOpenContext = createContext(true);

/**
 * One thread view's slots, shared by its transcript and its request cards. Each view has its own,
 * so the same thread open twice keeps each card in its own view. Outside one, rows leave no slot
 * and cards sit above the composer.
 */
export function ApprovalSlotsProvider({
  threadId,
  children,
}: {
  threadId: ThreadId;
  children: ReactNode;
}) {
  const [store] = useState(createSlots);
  const [value, setValue] = useState<Slots>({ threadId, store });
  if (value.threadId !== threadId) setValue({ threadId, store });
  return <SlotsContext value={value}>{children}</SlotsContext>;
}

/** Rows inside leave no slot while `open` is false: a closed run's line leaves it instead. */
export function ApprovalSlotsOpen({ open, children }: { open: boolean; children: ReactNode }) {
  return <SlotsOpenContext value={open}>{children}</SlotsOpenContext>;
}

const EMPTY = createSlots();

/**
 * The drawn slots of this view, by tool call id; `undefined` outside a thread view, where the
 * cards keep to their place above the composer.
 */
export function useApprovalSlots(): ReadonlyMap<string, HTMLElement> | undefined {
  const slots = use(SlotsContext);
  const drawn = useStore(slots?.store ?? EMPTY, (s) => s.slots);
  return slots === undefined ? undefined : drawn;
}

/** The call the thread's last approval answered, while its receipt shows. */
export function useReceiptCall(): string | undefined {
  const slots = use(SlotsContext);
  return useApprovalReceipts((s) =>
    slots === undefined ? undefined : s.byThread[slots.threadId]?.toolUseId,
  );
}

/**
 * Whether a call's row holds a slot now: while it waits on an approval, and after, while the
 * receipt of that answer shows.
 */
export function useNeedsSlot(): (toolCallId: string) => boolean {
  const awaiting = useAwaitingTools();
  const answered = useReceiptCall();
  return (toolCallId) => awaiting.has(toolCallId) || answered === toolCallId;
}

/**
 * Where the approval card for `toolCallId` is drawn, right under its row; nothing while the call
 * needs none, outside a thread view, or inside a closed run.
 */
export function ApprovalSlot({ toolCallId }: { toolCallId: string }) {
  const slots = use(SlotsContext);
  const open = use(SlotsOpenContext);
  const needs = useNeedsSlot()(toolCallId);
  const store = slots?.store;
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      if (element === null || store === undefined) return;
      store.getState().register(toolCallId, element);
      return () => store.getState().unregister(toolCallId, element);
    },
    [store, toolCallId],
  );
  if (store === undefined || !open || !needs) return null;
  // Empty until the card or its receipt is moved in, and then not a gap.
  return (
    <div
      ref={ref}
      data-testid="approval-slot"
      data-tool-call-id={toolCallId}
      className="empty:hidden"
    />
  );
}

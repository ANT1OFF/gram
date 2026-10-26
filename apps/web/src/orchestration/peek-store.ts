import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

/** What the peek sheet shows: a worker, or one of a worker's PRs. */
export type PeekTarget =
  | { readonly kind: "worker"; readonly threadId: ThreadId; readonly title: string }
  | {
      readonly kind: "pr";
      /** The worker whose PR it is. */
      readonly threadId: ThreadId;
      readonly repo: string;
      readonly number: number;
      readonly url?: string | undefined;
    };

interface PeekState {
  readonly open: boolean;
  /** Kept after closing, so the sheet keeps its content while it slides away. */
  readonly target: PeekTarget | undefined;
  /** The pane it opened from, which it covers the right side of; the window without one. */
  readonly container: HTMLElement | undefined;
  readonly show: (target: PeekTarget, from?: Element | null) => void;
  readonly close: () => void;
}

export const usePeekStore = create<PeekState>()((set) => ({
  open: false,
  target: undefined,
  container: undefined,
  show: (target, from) =>
    set({
      open: true,
      target,
      container: from?.closest<HTMLElement>("[data-pane-root]") ?? undefined,
    }),
  close: () => set({ open: false }),
}));

/**
 * Peeks at a worker or a PR in a sheet over the pane `from` is in. Looking sends nothing and never
 * holds the worker: the sheet only reads.
 */
export const peek = (target: PeekTarget, from?: Element | null) =>
  usePeekStore.getState().show(target, from);

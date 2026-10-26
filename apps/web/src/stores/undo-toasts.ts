import { create } from "zustand";

/**
 * A change made on the spot with a way back: "Paused platform · Undo". Kept apart from server
 * notifications, which are recorded in the notification history; an undo is only good while it
 * shows, so it is never recorded.
 */
export interface UndoToast {
  /** One toast per key: a later change to the same thing replaces the earlier one's toast. */
  readonly key: string;
  readonly title: string;
  readonly undo: () => Promise<unknown>;
  readonly at: number;
}

interface UndoToastsState {
  toasts: readonly UndoToast[];
  show: (toast: Omit<UndoToast, "at">) => void;
  dismiss: (toast: UndoToast) => void;
}

export const useUndoToasts = create<UndoToastsState>()((set) => ({
  toasts: [],
  show: (toast) =>
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => t.key !== toast.key).slice(-4),
        { ...toast, at: Date.now() },
      ],
    })),
  dismiss: (toast) => set((s) => ({ toasts: s.toasts.filter((t) => t !== toast) })),
}));

/** Says what just changed, with Undo; a failed undo says so in a toast of its own. */
export const showUndo = (toast: Omit<UndoToast, "at">): void =>
  useUndoToasts.getState().show(toast);

import { create } from "zustand";

interface ToastDockState {
  /** The right panel's toast slot while the panel is mounted; toasts render in it instead of floating. */
  readonly node: HTMLElement | null;
  setNode(node: HTMLElement | null): void;
}

export const useToastDock = create<ToastDockState>()((set) => ({
  node: null,
  setNode: (node) => set({ node }),
}));

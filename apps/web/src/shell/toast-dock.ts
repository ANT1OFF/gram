import { create } from "zustand";

interface ToastDockState {
  readonly node: HTMLElement | null;
  setNode(node: HTMLElement | null): void;
}

export const useToastDock = create<ToastDockState>()((set) => ({
  node: null,
  setNode: (node) => set({ node }),
}));

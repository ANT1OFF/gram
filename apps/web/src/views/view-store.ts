import { create } from "zustand";

// The window's view: Chat or Board over the same asks and workers, and Quiet on top of either. Per window and not persisted, so a launch opens on Chat. No React beyond the store.

/** What the window's main area shows. Chat is the route itself: a thread, Settings, a new task. */
export type AppView = "chat" | "board";

/** In the switcher's order, which is also the order of their keys. */
export const APP_VIEWS: readonly AppView[] = ["chat", "board"];

export const VIEW_LABELS: Record<AppView, string> = {
  chat: "Chat",
  board: "Board",
};

export interface ViewState {
  readonly view: AppView;
  /** One ask card and the status strip, over the whole window. Esc leaves it. */
  readonly quiet: boolean;
  /** A route change to this path keeps `view`, as a workspace switch does; any other goes to Chat. */
  readonly carry: string | undefined;
  /**
   * Counts every pick, the view already shown included, so a view can answer being picked again:
   * Board takes focus from the switcher whenever it's chosen, not only when it first opens.
   */
  readonly picks: number;
  setView(view: AppView): void;
  setQuiet(quiet: boolean): void;
  toggleQuiet(): void;
  /** Keeps the view through the navigation about to happen, to `pathname`. */
  carryView(pathname: string): void;
  /** The route is now `pathname`: back to Chat, unless `carryView` was going there. */
  routeChanged(pathname: string): void;
}

export const useViewStore = create<ViewState>()((set) => ({
  view: "chat",
  quiet: false,
  carry: undefined,
  picks: 0,
  setView: (view) => set((s) => ({ view, picks: s.picks + 1 })),
  setQuiet: (quiet) => set({ quiet }),
  toggleQuiet: () => set((s) => ({ quiet: !s.quiet })),
  carryView: (pathname) => set({ carry: pathname }),
  routeChanged: (pathname) =>
    set((s) => (s.carry === pathname ? { carry: undefined } : { carry: undefined, view: "chat" })),
}));

import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";
import type { GridLayout } from "./settings.ts";

// Multi-window: which window shows which thread.

/** One app window (or browser tab) and the threads its panes show. */
export const WindowPlacement = Schema.Struct({
  /** Stable for the window's lifetime; the desktop shell's first window is `w1`. */
  windowId: Schema.String,
  /** What the window calls itself: "Main", "Window 2"… */
  name: Schema.String,
  threadIds: Schema.Array(ThreadId),
});
export type WindowPlacement = typeof WindowPlacement.Type;

export const WindowPlacements = Schema.Struct({ windows: Schema.Array(WindowPlacement) });
export type WindowPlacements = typeof WindowPlacements.Type;

export const WatchWindowsPayload = { windowId: Schema.String, name: Schema.String };

export const ReportWindowPayload = {
  windowId: Schema.String,
  threadIds: Schema.Array(ThreadId),
  /** The sidebar is collapsed to the strip, so its rows' git chips aren't on screen. */
  sidebarCollapsed: Schema.optionalKey(Schema.Boolean),
  /** The window is on screen rather than minimised or hidden. Absent means "assume so". */
  visible: Schema.optionalKey(Schema.Boolean),
  /** The window has the user's attention. Absent means "assume so". */
  focused: Schema.optionalKey(Schema.Boolean),
  /**
   * The thread in the window's focused pane, `null` when that pane is empty. It is what the user is
   * looking at, so its GitHub state is refreshed when it changes and kept freshest after. Absent
   * keeps the last reported value, like the fields above.
   */
  focusedThreadId: Schema.optionalKey(Schema.NullOr(ThreadId)),
};

/** A desktop window as its renderer sees itself. */
export interface DesktopWindowInfo {
  readonly id: string;
  readonly name: string;
  /** The first window keeps its grid in `Settings.layout.grid`; the others keep theirs in the shell. */
  readonly primary: boolean;
  /** A thread handed to this window when it opened. */
  readonly initialThreadId?: string;
}

/** Multi-window affordances on `window.gram`; absent in a browser. */
export interface DesktopWindows {
  readonly window?: DesktopWindowInfo;
  /** Opens another window, showing `threadId` when given. */
  openWindow?(options?: { readonly threadId?: string }): Promise<void>;
  /** Brings window `windowId` forward, showing `threadId` there; resolves false when it's gone. */
  focusWindow?(windowId: string, threadId?: string): Promise<boolean>;
  /** The pane grid this (non-primary) window had when the app last closed. */
  windowLayout?(): Promise<GridLayout | undefined>;
  /** Saves this window's pane grid, restored with the window at the next launch. */
  setWindowLayout?(layout: GridLayout): void;
  /** Threads handed to this window by another one; returns the unsubscribe function. */
  onOpenThread?(callback: (threadId: string) => void): () => void;
}

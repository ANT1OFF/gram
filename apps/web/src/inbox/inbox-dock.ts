import { useRouterState } from "@tanstack/react-router";

import { useWindowWidth } from "@/shell/side-resize";
import {
  clampWidth,
  fitShell,
  shellPage,
  useLayoutStore,
  type ShellFit,
  type ShellFitInput,
  type WidthBounds,
} from "@/stores/layout";
import { useViewStore } from "@/views/view-store";

import {
  INBOX_CHAT_COMFORT_WIDTH,
  INBOX_CHAT_MIN_WIDTH,
  INBOX_DOCK_AUTO_MAX,
  INBOX_DOCK_WIDTH,
  useInboxStore,
} from "./inbox-store";

// Where the Inbox opens: docked in the side panel's column, beside the thread it answers for, or,
// where that column has no room for its list and detail side by side with the chat still at its
// reading width (a window under about 1,600 px) or the window is covered (Quiet), over everything
// as a dialog. One Inbox either way: the same list,
// selection and keys. No React but the hook at the end.

/** The inputs the dock reads: the overview's, which it sits beside, and the window's width. */
export type InboxDockInput = Pick<
  ShellFitInput,
  "windowWidth" | "focusMode" | "sidebarWidth" | "sidebarPeek" | "overviewSidebar"
>;

export interface InboxDockFit {
  /** The overview beside it, as `fitShell` lays it out with no panel. */
  readonly sidebar: ShellFit["sidebar"];
  readonly sidebarWidth: number;
  /** The dock's column. */
  readonly width: number;
  /** How wide it may be dragged in this window. */
  readonly bounds: WidthBounds;
}

/**
 * The docked Inbox in a window laid out as `input`, at the dragged `width`: it takes the panel's
 * column, which the panel gives up while it shows. It docks only where the chat keeps its
 * comfortable reading column (`INBOX_CHAT_COMFORT_WIDTH`) beside it at `INBOX_DOCK_WIDTH.min`, so
 * the chat is never squeezed to a strip beside it; in a narrower window (under about 1,600 px with
 * the overview open) it is a dialog over the work instead, undefined here. Dragged, it may leave the
 * chat `INBOX_CHAT_MIN_WIDTH`. Not dragged (`width` undefined), it takes what a wide window has past
 * the chat's reading column, up to `INBOX_DOCK_AUTO_MAX`.
 */
export function inboxDockFit(
  input: InboxDockInput,
  width: number | undefined,
): InboxDockFit | undefined {
  const fit = fitShell({
    ...input,
    threadInView: false,
    panelOpen: false,
    panelWidth: 0,
    panelExpanded: false,
    panelPeek: false,
    panelTab: "diff",
    reviewWidth: 0,
    reviewFocus: false,
    reviewRequestsPlacement: "hidden",
    openPrsPlacement: "hidden",
  });
  // Docked, the chat keeps its reading column; short of that the Inbox opens over the work.
  const room = Math.floor(input.windowWidth - fit.sidebarWidth - INBOX_CHAT_COMFORT_WIDTH);
  if (room < INBOX_DOCK_WIDTH.min) return undefined;
  // Dragged wider, it stops where the transcript beside it is still readable.
  const readable = Math.floor(input.windowWidth - fit.sidebarWidth - INBOX_CHAT_MIN_WIDTH);
  const max = Math.max(INBOX_DOCK_WIDTH.min, readable);
  const bounds = { ...INBOX_DOCK_WIDTH, max };
  const fitted = Math.min(
    INBOX_DOCK_AUTO_MAX,
    Math.floor(input.windowWidth - fit.sidebarWidth - INBOX_CHAT_COMFORT_WIDTH),
  );
  return {
    sidebar: fit.sidebar,
    sidebarWidth: fit.sidebarWidth,
    width: clampWidth(width ?? fitted, bounds),
    bounds,
  };
}

/**
 * The open Inbox's dock in this window, or undefined while it is closed or opens as a dialog (Quiet
 * covers the window, or the window is too narrow). The shell lays its columns out from it and the
 * dialog stays away while it is set, so the Inbox is never both.
 */
export function useInboxDock(): InboxDockFit | undefined {
  const open = useInboxStore((s) => s.open);
  const width = useInboxStore((s) => s.width);
  const quiet = useViewStore((s) => s.quiet);
  const focusMode = useLayoutStore((s) => s.focusMode);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const sidebarPeek = useLayoutStore((s) => s.sidebarPeek);
  const overviewSidebar = useLayoutStore((s) => s.overviewSidebar);
  const { width: windowWidth } = useWindowWidth();
  // Settings gives the overview's column to its narrow strip, as `useShellLayout` lays it out.
  const settings = useRouterState({
    select: (state) =>
      shellPage((state.resolvedLocation ?? state.location).pathname) === "/settings",
  });
  if (!open || quiet) return undefined;
  const strip = settings && !focusMode;
  return inboxDockFit(
    {
      windowWidth,
      focusMode,
      sidebarWidth,
      sidebarPeek: strip ? false : sidebarPeek,
      overviewSidebar: strip ? "compact" : overviewSidebar,
    },
    width,
  );
}

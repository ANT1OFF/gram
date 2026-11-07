import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { create } from "zustand";

import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { threadRoleOf } from "@/thread/orchestration-model";
import { useViewStore } from "@/views/view-store";

// One bar, not two: the shell's title bar carries what would be a second bar under it. A thread
// alone in Chat puts its header there, and Board its own controls. The shell marks the place; the
// view portals into it.

/** Under this width the title bar folds all it can into the "…" menu, whatever it carries. */
const TITLEBAR_FOLD_PX = 560;

/**
 * How far the title bar has folded into "…": 0 not at all, 1 its lesser buttons (Board's Grid or
 * Lanes), 2 a worker's own actions too (Open beside, Take over). The lesser go first, so a laptop's
 * bar keeps a worker's actions. Workers, Tidy up and the rest are always the "…"'s.
 */
export type TitlebarFold = 0 | 1 | 2;
/** The bar's last fold, where everything that folds has. */
export const FOLD_ALL = 2 satisfies TitlebarFold;

/** What a header in the bar marks: the room its title has, the attribute's value its least. */
const TITLEBAR_ROOM = "data-titlebar-room";
/** What a narrow bar folds away, the attribute's value the gap before it: see `Foldable`. */
const TITLEBAR_FOLD = "data-titlebar-fold";
/** The fold that takes it: see `Foldable`. */
const TITLEBAR_FOLD_LEVEL = "data-titlebar-fold-level";
/** Room to spare before folded buttons come back, so they never fold again at once. */
const UNFOLD_SLACK_PX = 16;
/** The title itself, inside the room: its whole width is what the bar folds for, up to a cap. */
const TITLEBAR_TITLE = "data-titlebar-title";
/** What in the room gives way before the title (the header's chips): no share of what it needs. */
const TITLEBAR_GIVES = "data-titlebar-gives";
/** The most of a title the bar folds its buttons for: a longer one still truncates. */
const TITLE_WANTS_PX = 240;

/** A header's title in the bar, as laid out now. */
export interface TitleInRoom {
  /** The width the room's contents take, from its start to the end of the last: free room past
      them is no part of what it needs. */
  readonly content: number;
  /** The title's whole width, and what of it shows. */
  readonly whole: number;
  readonly shown: number;
  /** What gives way before the title, the chips. */
  readonly gives: number;
}

/**
 * The room a header in the bar needs: its least, or what else the room holds (a glyph, the gaps)
 * and the title whole, up to a cap, whichever is more. The rest of the room keeps its size as the
 * bar folds and the title's whole width doesn't change, so folding for it never unfolds.
 */
export function titleRoomNeed(least: number, title: TitleInRoom | undefined): number {
  if (title === undefined) return least;
  const rest = Math.max(0, title.content - title.shown - title.gives);
  return Math.max(least, Math.ceil(rest + Math.min(title.whole, TITLE_WANTS_PX)));
}

/**
 * How far the bar folds, from what it has now. Narrow, it folds all; with anything spilling out of
 * the place, a step further. Else it folds as far as its title needs to keep its least room, and
 * unfolds a step only once that step's buttons fit back with the title still above its least: from
 * a width that just folded them, they would take the room back and fold again.
 */
export function nextFold(at: {
  readonly fold: TitlebarFold;
  readonly barWidth: number;
  /** The title's room over its least, or `Infinity` with no header to ask. */
  readonly spare: number;
  readonly overflow: boolean;
  /** Each fold's buttons' width and the gaps before them, the first fold's first. */
  readonly widths: readonly number[];
}): TitlebarFold {
  const width = (fold: number) => at.widths[fold - 1] ?? 0;
  if (at.barWidth < TITLEBAR_FOLD_PX) return FOLD_ALL;
  if (at.overflow) return Math.min(at.fold + 1, FOLD_ALL) as TitlebarFold;
  let fold = at.fold;
  let spare = at.spare;
  // Short of room: fold until what folds gives the title its least.
  while (spare < 0 && fold < FOLD_ALL) {
    fold += 1;
    spare += width(fold);
  }
  if (fold !== at.fold) return fold as TitlebarFold;
  // Room to spare: unfold while each step's buttons fit back with some over.
  while (fold > 0 && spare - width(fold) >= UNFOLD_SLACK_PX) {
    spare -= width(fold);
    fold -= 1;
  }
  return fold as TitlebarFold;
}

interface TitlebarSlotState {
  readonly slot: HTMLElement | null;
  /** How far the bar has folded its buttons into "…": see `TitlebarFold`. */
  readonly fold: TitlebarFold;
  setSlot(slot: HTMLElement | null): void;
  setFold(fold: TitlebarFold): void;
}

/** Where in the title bar the view's header goes, and how far the bar has folded. */
export const useTitlebarSlot = create<TitlebarSlotState>()((set) => ({
  slot: null,
  fold: 0,
  setSlot: (slot) => set({ slot }),
  setFold: (fold) => set({ fold }),
}));

/**
 * The thread whose header the title bar carries: the route's thread, when the grid shows it alone
 * and Chat is the view. A second pane brings each pane's header back, and Board has its own.
 */
export function useTitlebarThread(): ThreadId | undefined {
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  const alone = useLayoutStore((s) => (s.grid.panes.length === 1 ? s.grid.panes[0] : null));
  const chat = useViewStore((s) => s.view === "chat");
  return chat && route !== undefined && alone === route ? route : undefined;
}

/**
 * Whether the route's thread is a solo thread: no orchestrator, worker or dream role. Its bar
 * leaves out Chat · Board and the workspace's orchestration buttons, which act on work it is no
 * part of.
 */
export function useSoloRoute(): boolean {
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  return useThreadsStore((s) => {
    const thread = route === undefined ? undefined : s.byId[route]?.thread;
    return thread !== undefined && threadRoleOf(thread) === undefined;
  });
}

/** The agent of the route's thread ("claude", "codex"), whose usage the title bar's meter shows. */
export function useRouteAgent(): string | undefined {
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  return useThreadsStore((s) =>
    route === undefined ? undefined : s.byId[route]?.thread.model.agent,
  );
}

/** From `room`'s start to the far edge of its furthest child. */
function contentWidth(room: Element): number {
  const start = room.getBoundingClientRect().left;
  let end = start;
  for (const child of room.children) end = Math.max(end, child.getBoundingClientRect().right);
  return end - start;
}

/**
 * Folds `bar` as `nextFold` says, as it resizes and as what its place carries comes, goes or
 * changes size. Measured a frame later: folding moves the chips, whose own observers would see it
 * mid-delivery.
 */
export function useTitlebarFold(bar: HTMLElement | null): void {
  useLayoutEffect(() => {
    if (bar === null) return;
    const { setFold } = useTitlebarSlot.getState();
    let room: Element | null = null;
    let frame = 0;
    const fit = () => {
      const { fold, slot } = useTitlebarSlot.getState();
      const next = slot?.querySelector(`[${TITLEBAR_ROOM}]`) ?? null;
      if (next !== room) {
        if (room !== null) resize.unobserve(room);
        if (next !== null) resize.observe(next);
        room = next;
      }
      // Each fold's parts, laid out even while folded, and the gap its row leaves before each.
      const widths = Array.from({ length: FOLD_ALL }, () => 0);
      for (const part of bar.querySelectorAll(`[${TITLEBAR_FOLD}]`)) {
        const level = Number(part.getAttribute(TITLEBAR_FOLD_LEVEL) ?? FOLD_ALL);
        widths[level - 1]! +=
          part.getBoundingClientRect().width + Number(part.getAttribute(TITLEBAR_FOLD));
      }
      // The title before the bar's lesser buttons: it folds them to show the title whole (up to
      // a cap), not only its few letters.
      const title = room?.querySelector(`[${TITLEBAR_TITLE}]`) ?? null;
      const gives = room?.querySelector(`[${TITLEBAR_GIVES}]`) ?? null;
      const least = titleRoomNeed(
        Number(room?.getAttribute(TITLEBAR_ROOM) ?? 0),
        room === null || title === null
          ? undefined
          : {
              content: contentWidth(room),
              whole: title.scrollWidth,
              shown: title.getBoundingClientRect().width,
              gives: gives?.getBoundingClientRect().width ?? 0,
            },
      );
      // The header itself: what rings it, a needs-you pulse say, may stand past it on purpose.
      const header = slot?.querySelector("header") ?? null;
      setFold(
        nextFold({
          fold,
          barWidth: bar.getBoundingClientRect().width,
          spare: room === null ? Infinity : room.getBoundingClientRect().width - least,
          overflow: header !== null && header.scrollWidth > header.clientWidth + 1,
          widths,
        }),
      );
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const resize = new ResizeObserver(later);
    resize.observe(bar);
    // What the place carries: another thread's header, Board's, a chip that came.
    const mutations = new MutationObserver(later);
    mutations.observe(bar, { childList: true, subtree: true, characterData: true });
    // A font arriving widens the title's whole width with nothing resized: measure it again.
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    fonts?.addEventListener("loadingdone", later);
    void fonts?.ready.then(later);
    fit();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      fonts?.removeEventListener("loadingdone", later);
      cancelAnimationFrame(frame);
    };
  }, [bar]);
}

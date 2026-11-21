import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { useLayoutEffect } from "react";
import { create } from "zustand";

import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { threadRoleOf } from "@/thread/orchestration-model";
import { useViewStore } from "@/views/view-store";

const TITLEBAR_FOLD_PX = 560;

/**
 * How far the title bar has folded into "…": 0 not at all, 1 its lesser buttons (none carry it
 * today), 2 the view's own actions too (Board's layout), 3 the bar's icons that have a "…" item
 * (Conversation only, usage), 4 Chat · Board and Settings. The lesser go first, so a laptop's bar
 * keeps the view's actions. A title folds the bar as far as `FOLD_VIEW` to show itself whole; the
 * steps past it fold only for a bar that doesn't fit: one that spills, or a title short of its
 * least. Workers, Tidy up and the rest are always the "…"'s.
 */
export type TitlebarFold = 0 | 1 | 2 | 3 | 4;
/** The fold that takes the view's own actions, and the last a narrow bar folds by its width. */
export const FOLD_VIEW = 2 satisfies TitlebarFold;
/** The fold that takes the bar's icons with a "…" item: Conversation only and the usage meter. */
export const FOLD_ICONS = 3 satisfies TitlebarFold;
/** The bar's last fold, where everything that folds has: Chat · Board and Settings too. */
export const FOLD_ALL = 4 satisfies TitlebarFold;

const TITLEBAR_ROOM = "data-titlebar-room";
const TITLEBAR_FOLD = "data-titlebar-fold";
const TITLEBAR_FOLD_LEVEL = "data-titlebar-fold-level";
const UNFOLD_SLACK_PX = 16;
const TITLEBAR_TITLE = "data-titlebar-title";
const TITLEBAR_GIVES = "data-titlebar-gives";
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

/** What the bar measured as it folded, unfolded: see `nextFold`. */
export interface TitlebarFoldAt {
  readonly fold: TitlebarFold;
  readonly barWidth: number;
  /** The title's room over what it needs (`titleRoomNeed`), or `Infinity` with no header to ask. */
  readonly spare: number;
  /**
   * The title's room over its bare least, which the folds past `FOLD_VIEW` keep; `spare` when
   * not given.
   */
  readonly tight?: number | undefined;
  /** What the bar carries, or the bar itself, runs past its end. */
  readonly overflow: boolean;
  /** Each fold's buttons' width and the gaps before them, the first fold's first. */
  readonly widths: readonly number[];
  /**
   * The bar's width each fold step needs to come back (the first fold's first), from the measure
   * that folded it: see `unfoldWidths`. A step without one comes back by its room alone.
   */
  readonly unfoldAt?: readonly number[] | undefined;
}

const floorOf = (barWidth: number): TitlebarFold => (barWidth < TITLEBAR_FOLD_PX ? FOLD_VIEW : 0);

const roomFor = (step: number, spare: number, tight: number) => (step <= FOLD_VIEW ? spare : tight);

/**
 * How far the bar folds, from what it has now. Narrow, it folds at least the view's actions; with
 * anything spilling out of the bar or its place, a step further. Else it folds as far as its title
 * needs to keep its room, and unfolds a step only once that step's buttons fit back with the title
 * still above it: from a width that just folded them, they would take the room back and fold again.
 * Nor before the bar is as wide as that step needed when it folded (`unfoldAt`): folded, the bar is
 * laid out apart (the workspace's switcher narrows, a hold chip goes to its glyph, a crumb comes
 * back), so the room it measures then isn't the room the step would have back.
 */
export function nextFold(at: TitlebarFoldAt): TitlebarFold {
  const width = (fold: number) => at.widths[fold - 1] ?? 0;
  const floor = floorOf(at.barWidth);
  if (at.overflow) return Math.min(Math.max(at.fold + 1, floor), FOLD_ALL) as TitlebarFold;
  let fold: number = at.fold;
  let spare = at.spare;
  let tight = at.tight ?? at.spare;
  for (let step = fold + 1; step <= FOLD_ALL; step++) {
    if (step > floor && roomFor(step, spare, tight) >= 0) break;
    fold = step;
    spare += width(step);
    tight += width(step);
  }
  if (fold !== at.fold) return fold as TitlebarFold;
  while (
    fold > floor &&
    roomFor(fold, spare, tight) - width(fold) >= UNFOLD_SLACK_PX &&
    at.barWidth >= (at.unfoldAt?.[fold - 1] ?? 0)
  ) {
    spare -= width(fold);
    tight -= width(fold);
    fold -= 1;
  }
  return fold as TitlebarFold;
}

/**
 * The bar's width each fold step needs to come back, once `nextFold` has gone from `at.fold` to
 * `next`. A step that folds for the title is measured as it folds, with the bar still unfolded: it
 * needs the bar to grow by the room the title was short, and the slack. One that folds for what
 * spilled, with no room to go by, needs the bar wider than now by the slack. One that unfolds
 * forgets its width, and the steps the bar keeps keep theirs. Narrow, the bar's width alone decides
 * the steps it folds by width, so they need none.
 */
export function unfoldWidths(at: TitlebarFoldAt, next: TitlebarFold): readonly number[] {
  const kept = (at.unfoldAt ?? []).slice(0, next);
  if (next <= at.fold) return kept;
  const floor = floorOf(at.barWidth);
  const widths = [...kept];
  let spare = at.spare;
  let tight = at.tight ?? at.spare;
  for (let step = at.fold + 1; step <= next; step++) {
    const room = roomFor(step, spare, tight);
    widths[step - 1] =
      step <= floor
        ? 0
        : at.overflow
          ? at.barWidth + UNFOLD_SLACK_PX
          : Math.ceil(at.barWidth - room + UNFOLD_SLACK_PX);
    spare += at.widths[step - 1] ?? 0;
    tight += at.widths[step - 1] ?? 0;
  }
  return widths.every((each) => each === 0) ? kept : widths;
}

interface TitlebarSlotState {
  readonly slot: HTMLElement | null;
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

let headerSeq = 0;
const headerIds = new WeakMap<Element, number>();
function headerId(header: Element | null): number | "" {
  if (header === null) return "";
  let id = headerIds.get(header);
  if (id === undefined) headerIds.set(header, (id = ++headerSeq));
  return id;
}

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
    let held: { readonly of: string; readonly unfoldAt: readonly number[] } = {
      of: "",
      unfoldAt: [],
    };
    const fit = () => {
      const { fold, slot } = useTitlebarSlot.getState();
      const next = slot?.querySelector(`[${TITLEBAR_ROOM}]`) ?? null;
      if (next !== room) {
        if (room !== null) resize.unobserve(room);
        if (next !== null) resize.observe(next);
        room = next;
      }
      const widths = Array.from({ length: FOLD_ALL }, () => 0);
      for (const part of bar.querySelectorAll(`[${TITLEBAR_FOLD}]`)) {
        const level = Number(part.getAttribute(TITLEBAR_FOLD_LEVEL) ?? FOLD_ALL);
        widths[level - 1]! +=
          part.getBoundingClientRect().width + Number(part.getAttribute(TITLEBAR_FOLD));
      }
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
      const header = slot?.querySelector("header") ?? null;
      const leastRoom = Number(room?.getAttribute(TITLEBAR_ROOM) ?? 0);
      const of = [
        headerId(header),
        title?.scrollWidth ?? "",
        room?.getAttribute(TITLEBAR_ROOM) ?? "",
        ...widths.map(Math.round),
      ].join(" ");
      const at: TitlebarFoldAt = {
        fold,
        barWidth: bar.getBoundingClientRect().width,
        spare: room === null ? Infinity : room.getBoundingClientRect().width - least,
        tight: room === null ? Infinity : room.getBoundingClientRect().width - leastRoom,
        overflow:
          (header !== null && header.scrollWidth > header.clientWidth + 1) ||
          bar.scrollWidth > bar.clientWidth + 1,
        widths,
        unfoldAt: held.of === of ? held.unfoldAt : undefined,
      };
      const folds = nextFold(at);
      held = { of, unfoldAt: unfoldWidths(at, folds) };
      setFold(folds);
    };
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    const resize = new ResizeObserver(later);
    resize.observe(bar);
    const mutations = new MutationObserver(later);
    mutations.observe(bar, { childList: true, subtree: true, characterData: true });
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

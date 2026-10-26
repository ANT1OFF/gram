import type { Project, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useMemo } from "react";
import { create } from "zustand";

import { useApi } from "@/api/context";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { useLayoutStore } from "@/stores/layout";
import { useRequestRevealStore, useRevealStore } from "@/stores/reveal";
import { useTrayUnfold } from "@/thread/waiting-tray";
import { useViewStore } from "@/views/view-store";

import { useAskStackStore } from "./ask-stack-store";
import { useDerivedAsks } from "./needs-you-store";
import {
  stepItem,
  type NeedsYouFilter,
  type NeedsYouGroup,
  type NeedsYouItem,
} from "./needs-you-items";
import { useOpenQuestionsOf } from "./use-board-actions";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";

// The one list of what needs the user (needs-you-items.ts), and the one place it opens: the
// overview's pill and ⌘⌥3 open the Needs you popover; See all opens it as the right panel; ⌘⇧U
// and ⌘⇧Y walk it, each step opening its item's thread at the message that asked.

/** Where the popover is anchored: the open overview's pill, or the compact rail's. */
export type NeedsYouAnchor = "overview" | "rail";

interface NeedsYouUiState {
  /** The anchor whose popover is open, if any. */
  readonly popover: NeedsYouAnchor | undefined;
  /** The item last opened from here, which the next step moves on from. */
  readonly current: string | undefined;
  /** The panel's filter. */
  readonly filter: NeedsYouFilter;
  /** Whether the panel lists what is put away for Later instead. */
  readonly later: boolean;
  setPopover(anchor: NeedsYouAnchor | undefined): void;
  setCurrent(key: string | undefined): void;
  setFilter(filter: NeedsYouFilter): void;
  setLater(later: boolean): void;
}

export const useNeedsYouUi = create<NeedsYouUiState>()((set) => ({
  popover: undefined,
  current: undefined,
  filter: "all",
  later: false,
  setPopover: (popover) => set({ popover }),
  setCurrent: (current) => set({ current }),
  setFilter: (filter) => set({ filter }),
  setLater: (later) => set({ later }),
}));

/** An item put away for Later, with the epoch ms it comes back. */
interface LaterItem {
  readonly item: NeedsYouItem;
  readonly wakes: number;
}

export interface NeedsYouList {
  /** What needs the user now, by workspace. */
  readonly groups: readonly NeedsYouGroup[];
  /** The same, flat, in the order the groups list them: what the next and previous keys walk. */
  readonly items: readonly NeedsYouItem[];
  /** What is put away for Later, soonest back first. */
  readonly later: readonly LaterItem[];
}

/**
 * Every workspace's asks and standing failures and every thread's Waiting on you items, less what
 * is answered, being answered or dismissed, with what is put away for Later apart. `NeedsYouSource`
 * derives it once for the window.
 */
export function useNeedsYouList(): NeedsYouList {
  return useDerivedAsks((s) => s.needsYou);
}

/**
 * Hands what asks and Needs you read from queries (the workspaces, their open questions, ledgers
 * and projects) to `useDerivedAsks`, which derives both once for the window. The shell mounts one.
 */
export function NeedsYouSource(): null {
  const api = useApi();
  const workspaces = useWorkspaces();
  const workspaceIds = useMemo(() => workspaces.map((state) => state.workspace.id), [workspaces]);
  const questions = useOpenQuestionsOf(workspaceIds);
  // The workers' questions forwarded to the user ride on each workspace's ledger.
  const ledgers = useOrchestratorLedgers(workspaceIds);
  const { data: projects = NO_PROJECTS } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.listProjects(),
  });
  // Before paint, so a view reading the lists never shows a frame behind what was fetched.
  useLayoutEffect(() => {
    useDerivedAsks.getState().setQueried({ workspaces, questions, ledgers, projects });
  }, [workspaces, questions, ledgers, projects]);
  return null;
}

const NO_PROJECTS: readonly Project[] = [];

/** The selector a rendered pill answers to, by anchor. */
const ANCHOR_TEST_IDS: Record<NeedsYouAnchor, string> = {
  overview: "overview-needs-you",
  rail: "overview-rail-needs-you",
};

/**
 * Opens Needs you where it can be seen: the popover on whichever pill is on screen, or the right
 * panel when the overview is hidden.
 */
export const openNeedsYou = () => {
  useViewStore.getState().setQuiet(false);
  const shown = (["overview", "rail"] as const).find(
    (anchor) =>
      document.querySelector<HTMLElement>(`[data-testid="${ANCHOR_TEST_IDS[anchor]}"]`)
        ?.offsetParent != null,
  );
  if (shown !== undefined) {
    const { popover, setPopover } = useNeedsYouUi.getState();
    setPopover(popover === shown ? undefined : shown);
    return;
  }
  useLayoutStore.getState().revealPanel("needsYou");
};

/** Opens the panel, the whole list beside the thread; the popover closes. */
export const openNeedsYouPanel = () => {
  useNeedsYouUi.getState().setPopover(undefined);
  useLayoutStore.getState().revealPanel("needsYou");
};

/** How long a card a jump lands on stays ringed. */
const FLASH_MS = 1_600;
/** How long a jump looks for a card that isn't drawn yet before it gives up. */
const FIND_MS = 3_000;

/**
 * Scrolls to the first element `selector` finds once its thread has drawn it, and rings it for a
 * moment. Cards above the composer are found this way; transcript messages go through the reveal
 * store, which also pages earlier history in.
 */
const ringWhenDrawn = (selector: string) => {
  const until = performance.now() + FIND_MS;
  const look = () => {
    // Drawn and shown: an approval queue keeps the others hidden until it shows this one.
    const found = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (element) => element.offsetParent !== null,
    );
    if (found === undefined) {
      if (performance.now() < until) requestAnimationFrame(look);
      return;
    }
    found.scrollIntoView({ block: "center" });
    found.setAttribute("data-needs-you-flash", "true");
    if (!found.hasAttribute("tabindex")) found.tabIndex = -1;
    found.focus({ preventScroll: true });
    setTimeout(() => found.removeAttribute("data-needs-you-flash"), FLASH_MS);
  };
  requestAnimationFrame(look);
};

/** A value quoted for an attribute selector: its backslashes and quotes escaped. */
const attr = (value: string) => value.replace(/["\\]/gu, "\\$&");

/** Where an item's thread shows it: the card to ring, or the message the reveal store scrolls to. */
export const jumpTarget = (
  item: NeedsYouItem,
):
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "card"; readonly selector: string; readonly requestId?: string }
  | { readonly kind: "stack"; readonly key: string }
  | { readonly kind: "tray" }
  | { readonly kind: "thread" } => {
  if (item.messageId !== undefined) return { kind: "message", messageId: item.messageId };
  const { ask } = item;
  if (ask?.worker !== undefined) {
    return {
      kind: "card",
      selector: `[data-testid="worker-question-card"][data-question="${attr(ask.worker.question.id)}"]`,
    };
  }
  // The orchestrator's own asks and open questions are answered in its stack.
  if (ask !== undefined && item.inStack === true) return { kind: "stack", key: ask.key };
  const request = ask?.group?.entries[0]?.request;
  if (request !== undefined) {
    return {
      kind: "card",
      selector: `[data-request-id="${attr(request.id)}"]`,
      requestId: request.id,
    };
  }
  return item.kind === "wait" ? { kind: "tray" } : { kind: "thread" };
};

/**
 * Opens an item's thread at the turn that asked: the transcript message, the card above the
 * composer, or the orchestrator's stack on that ask. The popover closes; the panel stays.
 */
export function useNeedsYouJump(): (item: NeedsYouItem) => void {
  const navigate = useNavigate();
  return (item) => {
    const { setCurrent, setPopover } = useNeedsYouUi.getState();
    setCurrent(item.key);
    setPopover(undefined);
    const threadId: ThreadId | undefined = item.threadId;
    if (threadId === undefined) return;
    const target = jumpTarget(item);
    const askStack = useAskStackStore.getState();
    if (target.kind === "message") useRevealStore.getState().reveal(threadId, target.messageId);
    if (target.kind === "stack") askStack.focus(target.key);
    if (target.kind === "tray") useTrayUnfold.getState().unfold(threadId);
    if (target.kind === "card" && target.requestId !== undefined) {
      useRequestRevealStore.getState().reveal(threadId, target.requestId);
    }
    const view = useViewStore.getState();
    view.setQuiet(false);
    if (view.view !== "chat") view.setView("chat");
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
    if (target.kind === "card") ringWhenDrawn(target.selector);
  };
}

/** Steps ⌘⌥↓ or ⌘⌥↑ through the list from the item last opened, and opens the one it lands on. */
export function useNeedsYouStep(items: readonly NeedsYouItem[]) {
  const jump = useNeedsYouJump();
  return (by: 1 | -1) => {
    const next = stepItem(items, useNeedsYouUi.getState().current, by);
    if (next !== undefined) jump(next);
  };
}

/** What ⌘⇧U and ⌘⇧Y run, which the palette's Next runs too; set by the shell's `NeedsYouShortcut`. */
let stepper: ((by: 1 | -1) => void) | undefined;
export const setNeedsYouStepper = (next: (by: 1 | -1) => void) => {
  stepper = next;
};
export const stepNeedsYou = (by: 1 | -1) => stepper?.(by);

/** Needs you's count and its toggle, for the overview's pill, the rail's and ⌘⌥3. */
export function useNeedsYou() {
  const { items } = useNeedsYouList();
  const hint = useShortcutHint("view.needsYou");
  return { count: items.length, open: openNeedsYou, label: "Needs you", hint };
}

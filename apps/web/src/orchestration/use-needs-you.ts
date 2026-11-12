import type { Project } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useMemo } from "react";

import { useApi } from "@/api/context";
import { showInbox, toggleInbox, useInboxStore } from "@/inbox/inbox-store";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { appPathname } from "@/lib/app-path";
import { attr, ringWhenDrawn } from "@/lib/ring-when-drawn";
import { useLayoutStore } from "@/stores/layout";
import { useRequestRevealStore, useRevealStore } from "@/stores/reveal";
import { useTrayUnfold } from "@/thread/waiting-tray";
import { useViewStore } from "@/views/view-store";
import { useViewSolo, useViewWorkspace } from "@/views/view-workspace";

import { useDerivedAsks } from "./needs-you-store";
import {
  kindParts,
  needsYouCounts,
  needsYouIn,
  scopeLines,
  stepItem,
  type NeedsYouGroup,
  type NeedsYouCounts,
  type NeedsYouItem,
  type NeedsYouScope,
  type NeedsYouSection,
} from "./needs-you-items";
import { useOpenQuestionsOf } from "./use-board-actions";
import { useOrchestratorLedgers, useWorkspaces } from "./use-orchestration";

// The one list of what needs the user (needs-you-items.ts), and the one place it opens: the Inbox
// (inbox/inbox-view.tsx), from the title bar's Inbox button, the sidebar's pill, ⌘⇧I and ⌘⌥3.
// ⌘⇧U and ⌘⇧Y walk the list, each step opening its item's thread at the turn that asked.

/** An item put away for Later, with the epoch ms it comes back. */
interface LaterItem {
  readonly item: NeedsYouItem;
  readonly wakes: number;
}

export interface NeedsYouList {
  /** What needs the user now, by workspace: what each workspace's count reads. */
  readonly groups: readonly NeedsYouGroup[];
  /** The same by kind (`needsYouSections`): what the Inbox lists. */
  readonly sections: readonly NeedsYouSection[];
  /** The same, flat, in the order the sections list them: what the next and previous keys walk. */
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

/** Where an item's thread shows it: the card to ring, or the message the reveal store scrolls to. */
export const jumpTarget = (
  item: NeedsYouItem,
):
  | { readonly kind: "message"; readonly messageId: string }
  | { readonly kind: "card"; readonly selector: string; readonly requestId?: string }
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
 * Opens an item's thread at the turn that asked: the transcript message, or its card above the
 * composer, ringed. The Inbox closes, so the thread is what is seen, and the ringed card takes
 * focus.
 */
export function useNeedsYouJump(): (item: NeedsYouItem) => void {
  const navigate = useNavigate();
  return (item) => {
    const inbox = useInboxStore.getState();
    inbox.select(item.key);
    if (inbox.open) inbox.leave();
    const target = jumpTarget(item);
    const threadId = item.threadId;
    if (threadId === undefined) return;
    if (target.kind === "message") useRevealStore.getState().reveal(threadId, target.messageId);
    if (target.kind === "tray") useTrayUnfold.getState().unfold(threadId);
    if (target.kind === "card" && target.requestId !== undefined) {
      useRequestRevealStore.getState().reveal(threadId, target.requestId);
    }
    const view = useViewStore.getState();
    view.setQuiet(false);
    if (view.view !== "chat") view.setView("chat");
    useLayoutStore.getState().openThread(threadId);
    const pathname = `/t/${threadId}`;
    if (appPathname() !== pathname) {
      void navigate({ to: "/t/$threadId", params: { threadId } });
    }
    if (target.kind === "card") ringWhenDrawn(target.selector);
  };
}

/** Steps ⌘⌥↓ or ⌘⌥↑ through the list from the item last opened, and opens the one it lands on. */
export function useNeedsYouStep(items: readonly NeedsYouItem[]) {
  const jump = useNeedsYouJump();
  return (by: 1 | -1) => {
    const next = stepItem(items, useInboxStore.getState().selected, by);
    if (next !== undefined) jump(next);
  };
}

/** What ⌘⇧U and ⌘⇧Y run, which the palette's Next runs too; set by the shell's `NeedsYouShortcut`. */
let stepper: ((by: 1 | -1) => void) | undefined;
export const setNeedsYouStepper = (next: (by: 1 | -1) => void) => {
  stepper = next;
};
export const stepNeedsYou = (by: 1 | -1) => stepper?.(by);

/**
 * Every needs-you count (`needsYouCounts`): the pill's total and each workspace's badge, in the
 * open overview, the compact rail and the workspace switcher. Nothing else counts what needs you.
 */
export function useNeedsYouCounts(): NeedsYouCounts {
  const { groups } = useNeedsYouList();
  return useMemo(() => needsYouCounts(groups), [groups]);
}

/**
 * What needs you in `scope` (`needsYouIn`), and what needs you everywhere else: a surface that shows
 * one workspace's share says how much more waits outside it, so its count never reads as the
 * whole. `elsewhere` is `all` less `here`.
 */
export function useNeedsYouIn(scope: NeedsYouScope): {
  readonly here: readonly NeedsYouItem[];
  readonly elsewhere: readonly NeedsYouItem[];
} {
  const { groups } = useNeedsYouList();
  // A new object for the same workspace is the same scope.
  const kind = typeof scope === "string" ? scope : "workspace";
  const workspaceId = typeof scope === "string" ? undefined : scope.workspaceId;
  return useMemo(() => {
    const here = needsYouIn(
      groups,
      kind === "workspace" && workspaceId !== undefined
        ? { workspaceId }
        : (kind as "all" | "solo"),
    );
    const mine = new Set(here.map((item) => item.key));
    return {
      here,
      elsewhere: needsYouIn(groups, "all").filter((item) => !mine.has(item.key)),
    };
  }, [groups, kind, workspaceId]);
}

/**
 * Needs you's count across every workspace, what it is by kind ("1 question, 1 error") and the
 * Inbox's toggle, for the title bar's button. Reads no route: the pills' own here/elsewhere is
 * `useNeedsYouPill`'s.
 */
export function useNeedsYou() {
  const { total } = useNeedsYouCounts();
  const { items } = useNeedsYouList();
  const parts = useMemo(() => kindParts(items), [items]);
  const hint = useShortcutHint("inbox.open");
  return {
    count: total,
    kinds: parts.join(", "),
    parts,
    open: toggleInbox,
    label: "Inbox",
    hint,
  };
}

/**
 * The sidebar's pills: `useNeedsYou`, plus how much of the count is here and how much elsewhere
 * (`scopeLines`, for the hover) and `openAsks`, which opens on the newest ask in the workspace in
 * view, or anywhere when nothing here asks, and never on the first error.
 */
export function useNeedsYouPill() {
  const needs = useNeedsYou();
  const { groups } = useNeedsYouList();
  const solo = useViewSolo();
  const viewed = useViewWorkspace()?.workspace;
  const hereId = solo ? undefined : viewed?.id;
  const hereName = viewed?.name;
  const scope = useMemo(
    () =>
      scopeLines(
        groups,
        hereId === undefined ? undefined : { workspaceId: hereId, name: hereName ?? "" },
      ).join("\n"),
    [groups, hereId, hereName],
  );
  return {
    ...needs,
    scope,
    openAsks: () => showInbox(hereId === undefined ? { ask: true } : { workspaceId: hereId }),
  };
}

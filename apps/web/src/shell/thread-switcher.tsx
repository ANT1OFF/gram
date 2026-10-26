import type { ThreadId } from "@gram/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { AgentIcon } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { prefillDraftProject } from "@/composer/draft-prefill";
import { focusOtherWindow } from "@/desktop/open-thread";
import { useShortcut } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { useListedThreads } from "@/sidebar/listed";
import { threadStatusOf } from "@/sidebar/status";
import { useLayoutStore } from "@/stores/layout";
import { switchOrder, useThreadHistory } from "@/stores/thread-history";
import { useThreadsStore } from "@/stores/threads";
import { reopenLastClosed } from "@/thread/reopen-closed";

/** The thread in the focused pane. */
export const focusedThreadId = (): ThreadId | undefined => {
  const { grid } = useLayoutStore.getState();
  return grid.panes[grid.focused] ?? undefined;
};

/**
 * Loads `threadId` into the focused pane (or focuses the pane showing it) and names it in the route;
 * a desktop window already showing it comes forward instead.
 */
export function useOpenThread() {
  const navigate = useNavigate();
  return (threadId: ThreadId) => {
    if (focusOtherWindow(threadId)) return;
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
}

/**
 * Mount once. Ctrl+Tab walks the threads most recent first while Ctrl is held; releasing Ctrl opens
 * the pick in the focused pane and Escape cancels. ⌘⇧T reopens the last closed thread, and ⌘T drafts
 * a new thread in the current thread's project.
 */
export function ThreadSwitcher() {
  const api = useApi();
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  const open = useOpenThread();
  const byId = useListedThreads();
  const [cycle, setCycle] = useState<{ order: ThreadId[]; index: number }>();

  // Every focus change moves that thread to the front of the most-recent order.
  useEffect(() => {
    const touch = (threadId: ThreadId | null | undefined) => {
      if (threadId) useThreadHistory.getState().touch(threadId);
    };
    touch(focusedThreadId());
    return useLayoutStore.subscribe((s) => touch(s.grid.panes[s.grid.focused]));
  }, []);

  const step = (delta: 1 | -1) =>
    setCycle((current) => {
      const order =
        current?.order ??
        switchOrder(
          useThreadHistory.getState().recent,
          Object.values(useThreadsStore.getState().byId),
        );
      if (order.length === 0) return undefined;
      const from = current?.index ?? 0;
      return { order, index: (from + delta + order.length) % order.length };
    });

  useEffect(() => {
    if (!cycle) return;
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control") return;
      const threadId = cycle.order[cycle.index];
      setCycle(undefined);
      if (threadId && threadId !== focusedThreadId()) open(threadId);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setCycle(undefined);
    };
    const cancel = () => setCycle(undefined);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
    };
  });

  useShortcut({
    id: "thread.cycleNext",
    keys: "ctrl+tab",
    label: "Switch threads, most recent first (hold Ctrl)",
    group: "Navigation",
    allowInInputs: true,
    run: () => step(1),
  });

  useShortcut({
    id: "thread.cyclePrev",
    keys: "ctrl+shift+tab",
    label: "Switch threads backwards",
    group: "Navigation",
    allowInInputs: true,
    hidden: true,
    run: () => step(-1),
  });

  useShortcut({
    id: "thread.reopenClosed",
    keys: "mod+shift+t",
    label: "Reopen closed thread",
    group: "Thread",
    run: () => void reopenLastClosed(api, open),
  });

  useShortcut({
    id: "thread.newInProject",
    keys: "mod+t",
    label: "New one-off thread",
    group: "Navigation",
    run: () => {
      const threadId = (params.threadId as ThreadId | undefined) ?? focusedThreadId();
      const checkout = threadId ? byId[threadId]?.thread.checkout : undefined;
      prefillDraftProject(checkout ? (checkout.repoRoot ?? checkout.path) : undefined);
      void navigate({ to: "/new" });
    },
  });

  if (!cycle) return null;
  return (
    <div
      data-testid="thread-switcher"
      aria-label="Switch thread"
      className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
    >
      <ol
        aria-label="Recent threads"
        className="flex max-h-[60vh] w-[min(28rem,90vw)] flex-col overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {cycle.order.map((threadId, index) => {
          const summary = byId[threadId];
          if (!summary) return null;
          const display = threadStatusOf(summary);
          const selected = index === cycle.index;
          return (
            <li
              key={threadId}
              aria-current={selected ? "true" : undefined}
              data-testid="switcher-option"
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <display.icon aria-hidden className={cn("size-3.5 shrink-0", display.tone)} />
              <span className="min-w-0 flex-1 truncate">{summary.thread.title}</span>
              <AgentIcon
                agent={summary.thread.model.agent}
                labelled
                className="size-3.5 text-muted-foreground"
              />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

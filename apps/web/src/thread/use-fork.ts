import type { Thread, ThreadId, ThreadStatus } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage, isNotImplemented } from "@/api/errors";
import type { ForkThreadOptions } from "@/api/types";
import { useLayoutStore } from "@/stores/layout";
import { flushServerEvents, useThreadsStore } from "@/stores/threads";

const TURN_IN_PROGRESS: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "running",
  "needsApproval",
  "needsInput",
]);

/** Shown in the worktree dialog when a fork into the source checkout was refused. */
export const WORKTREE_NOTICE =
  "The source checkout is still in use, so this fork needs its own worktree.";

/** "opened" once the fork is showing; "needsWorktree" when only a new worktree can take it. */
export type ForkResult = "opened" | "needsWorktree" | "failed";

/** Whether the thread can be forked now, and why not when it can't. */
export function useForkAvailability(threadId: ThreadId): {
  available: boolean;
  reason: string | undefined;
} {
  const fork = useThreadsStore((s) => s.byId[threadId]?.capabilities?.fork);
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  // Capabilities reach the store with the next snapshot, so a thread created this session has none
  // yet; only an explicit `false` rules forking out, and the server refuses what it can't do.
  if (fork === false) return { available: false, reason: "This agent can't fork threads yet" };
  if (status !== undefined && TURN_IN_PROGRESS.has(status)) {
    return { available: false, reason: "Wait for the turn to finish" };
  }
  return { available: true, reason: undefined };
}

// The server refuses a fork into a checkout whose agent session is still open.
export const checkoutInUse = (error: unknown) =>
  errorMessage(error).includes("source checkout is in use");

export const forkErrorMessage = (error: unknown): string =>
  isNotImplemented(error)
    ? "Forking isn't available yet."
    : `Couldn't fork: ${errorMessage(error)}`;

/** Shows a fork: in an empty pane when the grid has one, else in the focused pane. */
export function openForkedThread(thread: Thread) {
  // The server's `thread.upsert` may arrive after the route changes; don't flash "not found".
  // An upsert the server sent before this answer may still wait for its frame: it goes first.
  flushServerEvents();
  useThreadsStore.getState().applyEvent({ type: "thread.upsert", thread });
  const { grid, openInPane, openThread } = useLayoutStore.getState();
  const empty = grid.panes.indexOf(null);
  if (empty !== -1) openInPane(thread.id, empty);
  else openThread(thread.id);
}

export function useForkThread(threadId: ThreadId) {
  const api = useApi();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const fork = async (options: ForkThreadOptions = {}): Promise<ForkResult> => {
    setPending(true);
    setError(undefined);
    try {
      const thread = await api.forkThread(threadId, options);
      openForkedThread(thread);
      void navigate({ to: "/t/$threadId", params: { threadId: thread.id } });
      return "opened";
    } catch (e) {
      if (options.checkout === undefined && checkoutInUse(e)) return "needsWorktree";
      setError(forkErrorMessage(e));
      return "failed";
    } finally {
      setPending(false);
    }
  };

  return { fork, pending, error, clearError: () => setError(undefined) };
}

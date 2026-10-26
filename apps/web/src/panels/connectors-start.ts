import type { ThreadId } from "@gram/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import type { Api, ConnectionState } from "@/api/types";
import { useThreadsStore } from "@/stores/threads";

/**
 * How long the tab is shown before the session starts, so flipping past it, or through threads with
 * the tab open, starts none.
 */
export const START_AFTER_MS = 600;

/**
 * Why a cold thread's session isn't started on its own as its Connectors tab opens, or `undefined`
 * when it is. `button` says whether the user can start it from the tab instead: an archived thread
 * and a dream never are, by the server's rule too.
 */
export interface StartHold {
  readonly reason: string;
  readonly button: boolean;
}

export interface StartFacts {
  readonly parked: boolean;
  readonly dream: boolean;
  /** Input waits in its queue, which a session would send as it opens. */
  readonly queued: boolean;
  /**
   * The thread's workspace is paused; `undefined` while that is being read, `unknown` when it
   * couldn't be, which holds the start as a pause would.
   */
  readonly workspacePaused: boolean | "unknown" | undefined;
  readonly connected: boolean;
  /**
   * The tab started this thread's session once already in this window, or has shown it running
   * since it opened: a session evicted while the tab looks on stays stopped.
   */
  readonly startedBefore: boolean;
}

/** {@link StartHold} from what the window knows of the thread; `undefined` lets it start. */
export const startHold = (facts: StartFacts): StartHold | undefined => {
  if (facts.parked) {
    return { reason: "Unarchive the thread to see its connectors live.", button: false };
  }
  if (facts.dream) {
    return { reason: "A dream's session runs only for its pass.", button: false };
  }
  // Opening would send it: that is the user's message to send, not this tab's.
  if (facts.queued) {
    return { reason: "A message waits to be sent; sending it starts the session.", button: false };
  }
  if (facts.workspacePaused === undefined) {
    return { reason: "Checking the thread's workspace…", button: false };
  }
  if (facts.workspacePaused === "unknown") {
    return {
      reason: "Couldn't tell whether its workspace is paused, so the session wasn't started.",
      button: true,
    };
  }
  if (facts.workspacePaused) {
    return {
      reason: "Its workspace is paused, so the session doesn't start on its own.",
      button: true,
    };
  }
  if (!facts.connected) {
    return { reason: "Gram isn't connected, so the session wasn't started.", button: true };
  }
  if (facts.startedBefore) {
    return { reason: "The session stopped after it sat idle.", button: true };
  }
  return undefined;
};

/** The threads whose tab started their session, per connection: never twice in one window. */
const startedByApi = new WeakMap<Api, Set<ThreadId>>();

const startedFor = (api: Api) => {
  let started = startedByApi.get(api);
  if (started === undefined) {
    started = new Set();
    startedByApi.set(api, started);
  }
  return started;
};

const OPEN: ConnectionState = { status: "open" };
const noop = () => () => {};

/** The socket's state; a test's API without a monitor counts as connected. */
const useConnected = (api: Api) => {
  const connection = api.connection as Api["connection"] | undefined;
  const state = useSyncExternalStore(
    connection?.subscribe ?? noop,
    connection?.get ?? (() => OPEN),
    connection?.get ?? (() => OPEN),
  );
  return state.status === "open";
};

export interface SessionStart {
  /** The session is opening: asked for here, or already on its way. */
  readonly starting: boolean;
  /** Why it wasn't started on its own; `undefined` while it may be, or once it has been. */
  readonly hold: StartHold | undefined;
  /** Why the last start was refused, or why the agent couldn't open the session. */
  readonly problem: string | undefined;
  /** Starts it now, as the button does. */
  readonly start: () => void;
}

/**
 * Starts a cold or evicted thread's agent session, with no turn, once its Connectors tab has been
 * shown for {@link START_AFTER_MS}, so the tab lists the session's connectors live
 * (`thread.startSession`). Opening connects the thread's MCP servers exactly as its next message
 * would: the thread starting itself, which every agent can do without a turn, and not a reader
 * looking, so Gram's readers still connect nothing. It starts once per thread in a window,
 * and never a session evicted while the tab is shown: those, a paused workspace and a dropped
 * connection get the button instead. A queued message, which the opening session would send, holds
 * it with no button.
 */
export function useSessionStart(threadId: ThreadId): SessionStart {
  const api = useApi();
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const parked = useThreadsStore((s) => s.byId[threadId]?.thread.parked === true);
  const dream = useThreadsStore((s) => s.byId[threadId]?.thread.role === "dream");
  const queued = useThreadsStore((s) => (s.byId[threadId]?.queue?.length ?? 0) > 0);
  const lastError = useThreadsStore((s) => s.byId[threadId]?.thread.lastError?.text);
  const workspaceId = useThreadsStore((s) => s.byId[threadId]?.thread.workspaceId);
  // Read whether or not Settings → Workspaces shows them: a pause holds the thread either way.
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
    enabled: workspaceId !== undefined,
    retry: false,
  });
  const connected = useConnected(api);
  const started = startedFor(api);
  const [seenUp, setSeenUp] = useState(false);
  if (!seenUp && status !== undefined && status !== "cold") setSeenUp(true);
  const mutation = useMutation({
    mutationFn: () => {
      started.add(threadId);
      return api.startSession(threadId);
    },
  });

  const workspace = workspaces.data?.find((w) => w.workspace.id === workspaceId);
  const workspacePaused =
    workspaceId === undefined
      ? false
      : workspaces.isError
        ? ("unknown" as const)
        : workspaces.data === undefined
          ? undefined
          : workspace === undefined
            ? ("unknown" as const)
            : workspace.paused !== undefined;
  const cold = status === "cold";
  const hold = cold
    ? startHold({
        parked,
        dream,
        queued,
        workspacePaused,
        connected,
        startedBefore: seenUp || started.has(threadId),
      })
    : undefined;
  const auto = cold && hold === undefined && !mutation.isPending;

  const { mutate } = mutation;
  useEffect(() => {
    if (!auto) return;
    const timer = setTimeout(() => mutate(), START_AFTER_MS);
    return () => clearTimeout(timer);
  }, [auto, mutate]);

  return {
    starting: status === "starting" || mutation.isPending || auto,
    hold: auto || mutation.isPending ? undefined : hold,
    problem:
      mutation.error !== null
        ? errorMessage(mutation.error)
        : // The open itself runs on after the call answers: an agent that can't start says so here.
          status === "error"
          ? lastError
          : undefined,
    start: () => mutate(),
  };
}

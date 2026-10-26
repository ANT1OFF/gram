import {
  openAtLaunchOf,
  type OpenAtLaunch,
  type ThreadId,
  type ThreadSummary,
  type Workspace,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { useServerSettings } from "@/settings-sync/store";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

import { useWorkspacesQuery } from "./use-orchestration";

// The orchestrator is home: a launch with a workspace opens one, the one used last first. With
// Settings → General → Open at launch at Last thread, a launch opens the thread shown last instead.

const LAST_KEY = "gram.lastOrchestratorWorkspace";
const LAST_THREAD_KEY = "gram.lastThread";

/** The workspace whose orchestrator the window showed last, across launches. */
export const readLast = (): WorkspaceId | undefined => {
  try {
    return (localStorage.getItem(LAST_KEY) ?? undefined) as WorkspaceId | undefined;
  } catch {
    return undefined;
  }
};

const writeLast = (workspaceId: WorkspaceId) => {
  try {
    localStorage.setItem(LAST_KEY, workspaceId);
  } catch {
    // Without storage, the most recently active orchestrator stands in.
  }
};

/** The thread the window showed last, orchestrator or not, across launches. */
const readLastThread = (): ThreadId | undefined => {
  try {
    return (localStorage.getItem(LAST_THREAD_KEY) ?? undefined) as ThreadId | undefined;
  } catch {
    return undefined;
  }
};

const writeLastThread = (threadId: ThreadId) => {
  try {
    localStorage.setItem(LAST_THREAD_KEY, threadId);
  } catch {
    // Without storage, a launch opens the orchestrator instead.
  }
};

/**
 * The orchestrator thread a launch opens: the workspace's used last, else the most recently active
 * one, else the first listed. `undefined` when no workspace has its orchestrator open.
 */
export function homeThread(
  workspaces: readonly WorkspaceState[],
  summaries: Readonly<Record<string, ThreadSummary>>,
  last: WorkspaceId | undefined,
): ThreadId | undefined {
  const open = workspaces.flatMap(({ workspace }) =>
    workspace.orchestratorThreadId === undefined
      ? []
      : [{ id: workspace.id, threadId: workspace.orchestratorThreadId }],
  );
  const remembered = open.find((each) => each.id === last);
  if (remembered !== undefined) return remembered.threadId;
  const activity = (threadId: ThreadId) => summaries[threadId]?.thread.lastActivityAt ?? 0;
  return open.reduce<(typeof open)[number] | undefined>(
    (best, each) =>
      best === undefined || activity(each.threadId) > activity(best.threadId) ? each : best,
    undefined,
  )?.threadId;
}

/**
 * The thread a launch opens: with `open` at `thread`, the one shown last while it is still listed;
 * otherwise, or when it is gone, `homeThread`'s orchestrator.
 */
export function launchThread(
  open: OpenAtLaunch,
  workspaces: readonly WorkspaceState[],
  summaries: Readonly<Record<string, ThreadSummary>>,
  last: WorkspaceId | undefined,
  lastThread: ThreadId | undefined,
): ThreadId | undefined {
  if (open === "thread" && lastThread !== undefined && summaries[lastThread] !== undefined)
    return lastThread;
  return homeThread(workspaces, summaries, last);
}

/** Remembers whose orchestrator, and which thread, the window shows, for the next launch. */
export function useRememberOrchestrator(): void {
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const { workspaces } = useWorkspacesQuery();
  const shown = workspaces.find(
    ({ workspace }) => threadId !== undefined && workspace.orchestratorThreadId === threadId,
  )?.workspace.id;
  useEffect(() => {
    if (shown !== undefined) writeLast(shown);
  }, [shown]);
  useEffect(() => {
    if (threadId !== undefined) writeLastThread(threadId);
  }, [threadId]);
}

/** How long the home page waits for the workspaces before it shows itself anyway. */
export const LANDING_WAIT_MS = 3_000;

/**
 * The window's one launch landing: whether it opened on the home page (read once, so only that
 * launch lands anywhere), whether it is decided, and whether it is on its way to an orchestrator.
 */
const launch = {
  home: typeof window !== "undefined" && window.location.pathname === "/",
  landed: false,
  leaving: false,
};

/** A fresh launch at `pathname`, for tests. */
export const resetLaunchForTests = (pathname: string): void => {
  launch.home = pathname === "/";
  launch.landed = false;
  launch.leaving = false;
};

/**
 * Settles the launch once the window shows anything but the home page: a deep link, or the user
 * going elsewhere before the workspaces arrived, so coming back to `/` later never redirects.
 */
export function useForgoLandingAway(): void {
  const away = useLocation({ select: (location) => location.pathname !== "/" });
  useEffect(() => {
    if (away) launch.landed = true;
  }, [away]);
}

/**
 * At launch, takes the home page to the thread `launchThread` picks, once the workspaces and
 * threads are known. True while that is still being decided, or the way there, so the page can hold
 * back its own content instead of flashing it; never longer than `LANDING_WAIT_MS`, so a server
 * that doesn't answer leaves the page as it is rather than blank.
 */
export function useLandOnOrchestrator(): boolean {
  const navigate = useNavigate();
  const { workspaces, settled } = useWorkspacesQuery();
  const ready = useThreadsStore((s) => s.ready);
  const byId = useThreadsStore((s) => s.byId);
  const open = useServerSettings((s) =>
    s.settings === undefined ? "orchestrator" : openAtLaunchOf(s.settings),
  );
  const [last] = useState(readLast);
  const [lastThread] = useState(readLastThread);
  const [lands] = useState(() => launch.home && !launch.landed);
  const [gaveUp, setGaveUp] = useState(false);
  // The threads rank the workspaces by activity, which the one used last doesn't need.
  const known = workspaces.some(
    ({ workspace }) => workspace.id === last && workspace.orchestratorThreadId !== undefined,
  );
  // The last thread is opened only once the threads say it is still there.
  const wantsThread = open === "thread" && lastThread !== undefined;
  const waiting = !settled || (!ready && (wantsThread || (!known && workspaces.length > 0)));
  // Decided once: a workspace that turns up after a launch that found none lands nowhere.
  const target =
    lands && !launch.landed && !waiting
      ? launchThread(open, workspaces, byId, last, lastThread)
      : undefined;
  useEffect(() => {
    if (!lands || waiting || launch.landed) return;
    launch.landed = true;
    if (target === undefined) return;
    launch.leaving = true;
    useLayoutStore.getState().openThread(target);
    void navigate({ to: "/t/$threadId", params: { threadId: target }, replace: true });
  }, [lands, waiting, target, navigate]);
  useEffect(() => {
    if (!lands) return;
    const timer = setTimeout(() => {
      if (launch.leaving) return;
      launch.landed = true;
      setGaveUp(true);
    }, LANDING_WAIT_MS);
    return () => clearTimeout(timer);
  }, [lands]);
  if (!lands || gaveUp) return false;
  return launch.leaving || (!launch.landed && (waiting || target !== undefined));
}

/** Opens a workspace where it lives: its orchestrator, which is started first when none is open. */
export function useOpenWorkspace(): (workspace: Workspace) => void {
  const api = useApi();
  const navigate = useNavigate();
  const open = (threadId: ThreadId) => {
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
  return (workspace) => {
    if (workspace.orchestratorThreadId !== undefined) return open(workspace.orchestratorThreadId);
    api
      .openOrchestrator({ workspaceId: workspace.id })
      .then((thread) => open(thread.id))
      .catch((error: unknown) =>
        useThreadDialogs.getState().fail(`Couldn't open the orchestrator: ${errorMessage(error)}`),
      );
  };
}

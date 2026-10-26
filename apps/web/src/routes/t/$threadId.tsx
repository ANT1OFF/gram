import type { ThreadId } from "@gram/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useApi } from "@/api/context";
import { BesideDock } from "@/orchestration/beside-dock";
import { ThreadGrid } from "@/shell/thread-grid";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

export const Route = createFileRoute("/t/$threadId")({
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const id = threadId as ThreadId;
  const api = useApi();
  const navigate = useNavigate();
  const unread = useThreadsStore((s) => s.byId[id]?.thread.unread ?? false);
  const focusedThread = useLayoutStore((s) => s.grid.panes[s.grid.focused] ?? null);
  const routeShown = useLayoutStore((s) => s.grid.panes.includes(id));

  useEffect(() => {
    if (unread) void api.markUnread(id, false);
  }, [api, id, unread]);

  // The route names the focused pane's thread: navigating loads the thread into the grid…
  useEffect(() => {
    useLayoutStore.getState().openThread(id);
  }, [id]);

  // …and focusing another pane navigates to its thread. Read the store fresh: the effect above
  // may have just changed it. Once the route's thread is in no pane (its pane was closed) and the
  // focused pane is empty, leave the route so a reload doesn't bring the thread back.
  useEffect(() => {
    const { grid } = useLayoutStore.getState();
    const current = grid.panes[grid.focused];
    if (current && current !== id) {
      void navigate({ to: "/t/$threadId", params: { threadId: current }, replace: true });
    } else if (focusedThread === null && !current && !routeShown && !grid.panes.includes(id)) {
      void navigate({ to: "/", replace: true });
    }
  }, [focusedThread, routeShown, id, navigate]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <ThreadGrid />
      <BesideDock />
    </div>
  );
}

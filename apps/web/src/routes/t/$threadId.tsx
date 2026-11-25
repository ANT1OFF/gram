import { ThreadId } from "@gram/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useApi } from "@/api/context";
import { useBesideSync } from "@/orchestration/beside-dock";
import { ThreadGrid } from "@/shell/thread-grid";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

export const Route = createFileRoute("/t/$threadId")({
  component: ThreadPage,
});

function ThreadPage() {
  const { threadId } = Route.useParams();
  const id = ThreadId.make(threadId);
  const api = useApi();
  const navigate = useNavigate();
  const unread = useThreadsStore((s) => s.byId[id]?.thread.unread ?? false);
  const focusedThread = useLayoutStore((s) => s.grid.panes[s.grid.focused] ?? null);
  const routeShown = useLayoutStore((s) => s.grid.panes.includes(id));
  useBesideSync();

  const loaded = useThreadsStore((s) => s.byId[id] !== undefined);
  const read = useRef<ThreadId | undefined>(undefined);
  useEffect(() => {
    if (!loaded || read.current === id) return;
    read.current = id;
    if (unread) void api.markUnread(id, false);
  }, [api, id, loaded, unread]);

  useEffect(() => {
    useLayoutStore.getState().openThread(id);
  }, [id]);

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
    </div>
  );
}

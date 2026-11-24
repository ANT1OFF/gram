import { useEffect, useRef } from "react";

import { useRouteThreadId } from "@/shell/route-params";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { checkRestored, closeBeside, useBesideStore } from "./beside-store";

/**
 * Keeps a worker restored from storage only while it is still a worker of the orchestrator in
 * view, and closes it once the worker is gone. Mounted with the thread page, as the panel isn't
 * while hidden.
 */
export function useBesideSync() {
  const worker = useBesideStore((s) => s.worker);
  const restored = useBesideStore((s) => s.restored);
  const record = useBesideStore((s) => s.record);
  const known = useThreadsStore((s) =>
    worker === undefined ? false : s.byId[worker] !== undefined,
  );
  const paneShown = useLayoutStore((s) => fitShell(s).panel !== "none");
  useEffect(() => {
    if (!paneShown && useBesideStore.getState().current !== undefined) {
      useBesideStore.setState({ current: undefined });
    }
  }, [paneShown]);
  const ready = useThreadsStore((s) => s.ready);
  const route = useRouteThreadId();
  useEffect(() => {
    if (ready && restored) checkRestored(route);
  }, [ready, restored, route]);
  useEffect(() => {
    if (worker !== undefined && ready && !known && !record) closeBeside();
  }, [worker, ready, known, record]);
  const lastRoute = useRef(route);
  useEffect(() => {
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    if (route !== undefined && useBesideStore.getState().worker === route) closeBeside();
  }, [route]);
}

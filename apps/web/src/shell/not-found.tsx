import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Signpost } from "lucide-react";
import { useSyncExternalStore } from "react";

import { EmptyState } from "@/components/empty-state";
import { useMountEffect } from "@/lib/effects";

let shown = 0;
const listeners = new Set<() => void>();
const tell = () => {
  for (const listener of listeners) listener();
};

/** Whether the window is on the not-found page now: the title bar and the tab name it so. */
export function useShowingNotFound(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown > 0,
  );
}

export function NotFound() {
  useMountEffect(() => {
    shown += 1;
    tell();
    return () => {
      shown -= 1;
      tell();
    };
  });
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <EmptyState
      testId="not-found"
      icon={Signpost}
      title="Nothing here"
      line={
        <>
          No page is at <span className="font-mono break-all">{pathname}</span>.
        </>
      }
      action={{
        label: "Go home",
        testId: "not-found-home",
        onClick: () => void navigate({ to: "/" }),
      }}
    />
  );
}

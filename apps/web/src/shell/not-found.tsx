import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Signpost } from "lucide-react";

import { EmptyState } from "@/components/empty-state";

/**
 * An address that leads to no page, drawn where the page would be, with the shell around it: what
 * happened, the path that was asked for, and the way home. Old links to a thread or a page that
 * has gone, and an app in front of Gram linking to a page it never added, both land here.
 */
export function NotFound() {
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

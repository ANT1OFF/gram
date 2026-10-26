import type { ThreadId } from "@gram/contracts";
import { RefreshCw } from "lucide-react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { useShortcut } from "@/keyboard/registry";
import { cn } from "@/lib/utils";
import { spin } from "@/motion";

/**
 * Refreshes a git panel on demand: asks the server to re-read the thread's git state and PR badge, and
 * refetches the panel's own query. Owns the `panel.refresh` shortcut while mounted.
 */
export function RefreshButton({
  threadId,
  label,
  fetching,
  refetch,
  className,
}: {
  threadId: ThreadId;
  label: string;
  fetching: boolean;
  refetch: () => Promise<unknown>;
  className?: string;
}) {
  const api = useApi();
  const refresh = () => {
    // The panel's own refetch surfaces any failure, so the server-side refresh stays best-effort.
    api.refreshGit(threadId).catch(() => undefined);
    void refetch();
  };
  useShortcut({
    id: "panel.refresh",
    keys: "mod+alt+r",
    label: "Refresh Diff / PR panel",
    group: "App",
    run: refresh,
  });

  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      aria-busy={fetching}
      disabled={fetching}
      onClick={refresh}
      className={cn("shrink-0", className)}
    >
      <RefreshCw aria-hidden ref={fetching ? spin : undefined} className="size-3.5" />
    </Button>
  );
}

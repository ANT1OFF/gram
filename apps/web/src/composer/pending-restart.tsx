import type { ThreadId, ThreadSummary } from "@gram/contracts";
import { RotateCw } from "lucide-react";

import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { useThreadsStore } from "@/stores/threads";
import { requestRestart } from "@/thread/restart-session";

/**
 * What the pending restart waits for, then the remedy: the hint on its glyph. `undefined` when no
 * restart is pending.
 */
export const pendingRestartHint = (
  summary: Pick<ThreadSummary, "pendingRestart" | "background"> | undefined,
): string | undefined => {
  if (summary?.pendingRestart === undefined) return undefined;
  const waitsFor =
    (summary.background?.length ?? 0) > 0
      ? "once its background tasks finish"
      : "once this turn and the queue are done";
  return `An MCP server or connector changed: the session restarts ${waitsFor} to load it.\nClick to restart now.`;
};

/**
 * Beside the usage ring while the session waits to restart for a changed MCP config: a quiet
 * glyph, which restarts it now through the menus' Restart session.
 */
export function PendingRestart({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const hint = useThreadsStore((s) => pendingRestartHint(s.byId[threadId]));
  if (hint === undefined) return null;
  return (
    <Hint
      label={hint}
      render={
        <button
          type="button"
          data-testid="pending-restart"
          aria-label="Restart pending: MCP config changed"
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={() => requestRestart(api, threadId)}
        />
      }
    >
      <RotateCw aria-hidden className="size-3.5" />
    </Hint>
  );
}

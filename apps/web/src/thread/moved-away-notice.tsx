import type { ThreadId } from "@gram/contracts";
import { CloudUpload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Above the composer once the thread moved to another Gram: it carries on there, and this copy is
 * read-only (a send is refused). Its folder stays, and opening it there is one click when the
 * other side said where.
 */
export function MovedAwayNotice({ threadId }: { threadId: ThreadId }) {
  const moved = useThreadsStore((s) => s.byId[threadId]?.thread.transferredTo);
  if (moved === undefined) return null;
  return (
    <aside
      aria-label="Moved to a server"
      data-testid="moved-away-notice"
      className="flex w-full thread-column shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 text-reading"
    >
      <CloudUpload aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1">
        Moved to {moved.name} on {when(moved.at)}.{" "}
        <span className="text-muted-foreground">
          It carries on there with its edits. This copy is read-only, and its folder stays here.
        </span>
      </p>
      {moved.url !== undefined && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => window.open(moved.url, "_blank", "noopener")}
        >
          Open it there
        </Button>
      )}
    </aside>
  );
}

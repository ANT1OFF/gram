import type { ThreadId } from "@gram/contracts";
import { CloudUpload, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useThreadsStore } from "@/stores/threads";

import { bringBackFrom } from "./move-thread-model";
import { settledThere } from "./thread-transfer-api";
import { useThreadDialogs } from "./thread-dialogs-store";
import { useThreadMove } from "./use-thread-move";

const when = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Above the composer once the thread moved to another Gram: it carries on there, and this copy is
 * read-only (a send is refused). Its folder stays, and opening it there is one click when the
 * other side said where. A thread that went to a server signed in to from here can be brought
 * back, when that server gives threads back.
 */
export function MovedAwayNotice({ threadId }: { threadId: ThreadId }) {
  const moved = useThreadsStore((s) => s.byId[threadId]?.thread.transferredTo);
  const { view } = useThreadMove();
  const bridge = typeof window === "undefined" ? undefined : window.gram?.hostedDevice;
  if (moved === undefined) return null;
  const canBring = bridge?.fetchThread !== undefined && bridge.settleThread !== undefined;
  const from = canBring ? bringBackFrom({ transferredTo: moved }, view) : undefined;
  const here = window.gram?.platform === "darwin" ? "this Mac" : "this computer";
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
      {from !== undefined && "why" in from && (
        <span data-testid="moved-away-why" className="text-meta text-muted-foreground">
          {from.why}
        </span>
      )}
      {from !== undefined && !("why" in from) && (
        <Button
          size="sm"
          variant="outline"
          data-testid="moved-away-bring"
          onClick={() => useThreadDialogs.getState().open({ kind: "bringThread", threadId })}
        >
          Bring back to {here}…
        </Button>
      )}
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

/**
 * Above the composer once a thread came back from a server whose copy there is still open, as
 * when that server didn't answer the settle, or the sheet closed before it did: two places could
 * carry it on. One click makes the copy there read-only.
 */
export function LeftOpenNotice({ threadId }: { threadId: ThreadId }) {
  const from = useThreadsStore((s) => s.byId[threadId]?.thread.transferredFrom);
  const settle =
    typeof window === "undefined" ? undefined : window.gram?.hostedDevice?.settleThread;
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string>();
  const open = from?.leftOpen;
  if (from === undefined || open === undefined) return null;
  const { exportedAt } = from;
  const settleThere =
    settle === undefined || exportedAt === undefined
      ? undefined
      : async () => {
          setBusy(true);
          setWhy(undefined);
          const settled = await settle(open.origin, open.workspaceId, threadId, exportedAt).catch(
            () => ({ ok: false as const, why: "The server didn't answer." }),
          );
          if (settled.ok) await settledThere(threadId).catch(() => undefined);
          else setWhy(settled.why);
          setBusy(false);
        };
  return (
    <aside
      aria-label="Still open on the server"
      data-testid="left-open-notice"
      className="flex w-full thread-column shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 text-reading"
    >
      <TriangleAlert aria-hidden className="size-icon-row shrink-0 text-warning-text" />
      <p className="min-w-0 flex-1">
        Its copy on {from.name} is still open.{" "}
        <span className="text-muted-foreground">Carry on here, not there.</span>
      </p>
      {why !== undefined && (
        <span role="alert" className="text-meta text-warning-text">
          {why}
        </span>
      )}
      {settleThere !== undefined && (
        <Button
          size="sm"
          variant="outline"
          data-testid="left-open-settle"
          disabled={busy}
          onClick={() => void settleThere()}
        >
          Make it read-only there
        </Button>
      )}
    </aside>
  );
}

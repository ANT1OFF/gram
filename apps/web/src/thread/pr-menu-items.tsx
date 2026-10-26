import type { ThreadId } from "@gram/contracts";
import { GitPullRequest, Link2, Unlink } from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { PrActionItems } from "@/components/pr-badge-menu";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { useThreadsStore } from "@/stores/threads";

import { useThreadDialogs } from "./thread-dialogs-store";

/**
 * The row menu's one "PR" submenu: actions on the badge PR, unbind the bound one, then bind a PR, which
 * follows it beside the bound one when there is one.
 */
export function PrContextMenuItems({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const boundPr = useThreadsStore((s) => s.byId[threadId]?.thread.boundPr);
  const hasPr = useThreadsStore((s) => s.byId[threadId]?.git?.pr !== undefined);

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <GitPullRequest aria-hidden className="size-3.5" />
        PR
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <PrActionItems threadId={threadId} />
        {hasPr && <ContextMenuSeparator />}
        {boundPr && (
          <ContextMenuItem
            onClick={() =>
              void api
                .prUnbind(threadId)
                .catch((error: unknown) =>
                  useThreadDialogs
                    .getState()
                    .fail(`Couldn't unbind the PR: ${errorMessage(error)}`),
                )
            }
          >
            <Unlink aria-hidden className="size-3.5" />
            Unbind #{boundPr.number}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() => useThreadDialogs.getState().open({ kind: "bindPr", threadId })}
        >
          <Link2 aria-hidden className="size-3.5" />
          {boundPr ? "Follow another PR…" : "Bind PR…"}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

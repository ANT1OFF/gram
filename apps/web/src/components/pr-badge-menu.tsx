import type { PrStatus, ThreadId } from "@gram/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  RefreshCw,
} from "lucide-react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openExternalUrl } from "@/api/open-external";
import { openPrPanel } from "@/components/git-badges";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { copyText } from "@/settings/copy-text";
import { useThreadsStore } from "@/stores/threads";
import { useThreadDialogs } from "@/thread/thread-dialogs-store";

/** The PR badge's menu items: copy its link, open it on GitHub, and refresh it from GitHub. */
export function PrBadgeMenuItems({ threadId, pr }: { threadId: ThreadId; pr: PrStatus }) {
  const api = useApi();
  return (
    <>
      <ContextMenuItem onClick={() => void copyText(pr.url).catch(() => undefined)}>
        <Copy aria-hidden className="size-3.5" />
        Copy PR link
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void openExternalUrl(api, pr.url)}>
        <ExternalLink aria-hidden className="size-3.5" />
        Open #{pr.number} on GitHub
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void api.refreshGit(threadId).catch(() => undefined)}>
        <RefreshCw aria-hidden className="size-3.5" />
        Refresh from GitHub
      </ContextMenuItem>
    </>
  );
}

/**
 * The row menu's actions on the thread's badge PR: the PR panel (merging and closing confirm there),
 * draft and reopen, then the badge's items. Nothing without a PR.
 */
export function PrActionItems({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const pr = useThreadsStore((s) => s.byId[threadId]?.git?.pr);
  if (!pr) return null;

  const write = (effect: () => Promise<void>, failure: string) =>
    void effect()
      .catch((error: unknown) =>
        useThreadDialogs.getState().fail(`${failure}: ${errorMessage(error)}`),
      )
      .finally(() => queryClient.invalidateQueries({ queryKey: ["git.prDetail", threadId] }));

  return (
    <>
      {pr.state === "OPEN" && (
        <>
          <ContextMenuItem onClick={() => openPrPanel(threadId)}>
            <GitMerge aria-hidden className="size-3.5" />
            Merge or close in PR panel
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() =>
              write(
                () => api.prReady(threadId, !pr.isDraft),
                pr.isDraft
                  ? `Couldn't mark #${pr.number} ready for review`
                  : `Couldn't convert #${pr.number} to a draft`,
              )
            }
          >
            <GitPullRequestDraft aria-hidden className="size-3.5" />
            {pr.isDraft ? "Ready for review" : "Convert to draft"}
          </ContextMenuItem>
        </>
      )}
      {pr.state === "CLOSED" && (
        <ContextMenuItem
          onClick={() => write(() => api.prReopen(threadId), `Couldn't reopen #${pr.number}`)}
        >
          <GitPullRequest aria-hidden className="size-3.5" />
          Reopen #{pr.number}
        </ContextMenuItem>
      )}
      <PrBadgeMenuItems threadId={threadId} pr={pr} />
    </>
  );
}

import type { GitState, ThreadId } from "@gram/contracts";
import { GitPullRequestArrow } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { openPrPanel } from "@/components/git-badges";
import { Button } from "@/components/ui/button";
import { focusOtherWindow } from "@/desktop/open-thread";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

/** A worktree's short name: its folder. */
export const worktreeName = (path: string): string =>
  path.split(/[\\/]/).findLast((part) => part !== "") ?? path;

/** The open PR on another worktree, while this branch has no PR of its own. */
const prElsewhereOf = (git: GitState | undefined) =>
  git !== undefined && git.pr === undefined ? git.prElsewhere : undefined;

/**
 * "#N on <branch>" in the badge area: this branch has no PR, but another worktree of the repo has an
 * open one. With `threadId` it opens the PR panel, where the actions are.
 */
export function PrElsewhereChip({
  git,
  threadId,
  testId,
  className,
  tabbable = true,
  compact = false,
}: {
  git: GitState | undefined;
  threadId?: ThreadId;
  testId: string;
  className?: string;
  /** Only the number beside the glyph, with the branch left to the tooltip. */
  compact?: boolean;
  /** False where the enclosing row is the Tab stop. */
  tabbable?: boolean;
}) {
  const elsewhere = prElsewhereOf(git);
  if (!elsewhere) return null;
  const title = [
    `#${elsewhere.number} ${elsewhere.title}`,
    `open on ${elsewhere.branch} in ${worktreeName(elsewhere.worktreePath)}`,
    "This branch has no PR of its own",
  ].join("\n");
  const interactive = threadId !== undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!interactive || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openPrPanel(threadId);
  };
  return (
    <span
      data-testid={testId}
      title={title}
      {...(interactive
        ? {
            role: "button",
            tabIndex: tabbable ? 0 : -1,
            onClick: () => openPrPanel(threadId),
            onKeyDown,
          }
        : {})}
      className={cn(
        "flex min-w-0 shrink items-center gap-0.5 rounded-sm border border-dashed border-border px-1",
        interactive && "cursor-pointer hover:bg-accent/40",
        className,
      )}
    >
      <GitPullRequestArrow aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        #{elsewhere.number}
        {!compact && ` on ${elsewhere.branch}`}
      </span>
    </span>
  );
}

const notify = (kind: "info" | "error", title: string, body: string) =>
  useThreadsStore.getState().applyEvent({ type: "notify", kind, title, body });

/** The PR panel's no-PR state: where the open PR is, with Open thread and Bind to this thread. */
export function PrElsewhereNotice({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const elsewhere = useThreadsStore((s) => prElsewhereOf(s.byId[threadId]?.git));
  const otherThread = elsewhere?.threadId;
  const otherOpen = useThreadsStore(
    (s) => otherThread !== undefined && s.byId[otherThread] !== undefined,
  );
  const [pending, setPending] = useState(false);
  if (!elsewhere) return null;

  const open = () => {
    if (otherThread === undefined || focusOtherWindow(otherThread)) return;
    useLayoutStore.getState().openThread(otherThread);
  };
  const bind = async () => {
    setPending(true);
    try {
      await api.prBind(threadId, elsewhere.repo, elsewhere.number);
      notify(
        "info",
        `Bound #${elsewhere.number}`,
        `This thread now follows ${elsewhere.repo}#${elsewhere.number}.`,
      );
    } catch (error) {
      notify("error", "Couldn't bind the PR", errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      data-testid="pr-elsewhere"
      className="flex flex-col items-center gap-2 px-4 pb-3 text-center text-xs text-muted-foreground"
    >
      <p>
        #{elsewhere.number} open on <span className="font-mono">{elsewhere.branch}</span> in{" "}
        {worktreeName(elsewhere.worktreePath)}
      </p>
      <div className="flex gap-2">
        {otherOpen && (
          <Button type="button" size="xs" variant="outline" onClick={open}>
            Open thread
          </Button>
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => void bind()}
        >
          Bind to this thread
        </Button>
      </div>
    </div>
  );
}

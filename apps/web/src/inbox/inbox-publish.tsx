import type { ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileDiff } from "lucide-react";
import { useId } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/motion";
import type { InboxEntry } from "@/orchestration/inbox-model";
import { useThreadsStore } from "@/stores/threads";

import { publishSummaryOf } from "./inbox-publish-model";

/**
 * Under an approval that would push a branch or open its pull request, what each asking thread
 * would publish: its branch against its base, in files and lines, and Review changes, which opens
 * the thread on its Diff. So the person can judge the change before allowing it, not after.
 */
export function InboxPublish({
  entries,
  onReview,
}: {
  entries: readonly Pick<InboxEntry, "threadId" | "title" | "checkout">[];
  onReview: (threadId: ThreadId) => void;
}) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      data-testid="inbox-publish"
      className="mx-2 mt-3 flex flex-col gap-1.5 rounded-(--radius-md) border border-border px-3 py-2"
    >
      <h3 id={heading} className="text-meta text-muted-foreground">
        {entries.length === 1 ? "What it would publish" : "What they would publish"}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <PublishRow
            key={entry.threadId}
            threadId={entry.threadId}
            title={entry.title}
            branch={entry.checkout?.branch}
            named={entries.length > 1}
            onReview={() => onReview(entry.threadId)}
          />
        ))}
      </ul>
    </section>
  );
}

function PublishRow({
  threadId,
  title,
  branch,
  named,
  onReview,
}: {
  threadId: ThreadId;
  title: string;
  branch: string | undefined;
  named: boolean;
  onReview: () => void;
}) {
  const api = useApi();
  const stamp = useThreadsStore((s) => {
    const git = s.byId[threadId]?.git;
    return git === undefined
      ? null
      : `${git.changesToken}:${git.base ?? ""}:${git.behindBase}:${git.aheadBase}`;
  });
  const query = useQuery({
    queryKey: ["git.diff", threadId, "branch", null, stamp, false],
    queryFn: () => api.gitDiff(threadId, { kind: "branch" }),
    retry: false,
  });
  const summary = query.data === undefined ? undefined : publishSummaryOf(query.data);
  const onBranch = query.data?.branch ?? branch;
  return (
    <li data-testid="inbox-publish-row" className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
        <p className="flex min-w-0 items-center gap-1.5 text-body">
          <FileDiff aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
          {named && <span className="truncate">{title}</span>}
          {onBranch !== undefined && (
            <span className="truncate font-mono text-meta text-muted-foreground">
              {onBranch}
              {summary?.base !== undefined && ` → ${summary.base}`}
            </span>
          )}
        </p>
        <p
          data-testid="inbox-publish-summary"
          className="flex items-center gap-1.5 pl-6 text-meta text-muted-foreground tabular-nums"
        >
          {query.isPending ? (
            <>
              <Spinner aria-hidden className="size-icon-chip" />
              Reading its changes…
            </>
          ) : query.isError ? (
            "Couldn't read its changes here. Review changes opens its Diff."
          ) : summary === undefined ? (
            "Its folder isn't a repository, so there is nothing to compare."
          ) : summary.files === undefined ? (
            (summary.note ?? "Too large to count here.")
          ) : summary.files === 0 ? (
            `No changes against ${summary.base ?? "its base"}.`
          ) : (
            <>
              {summary.files === 1 ? "1 file changed" : `${summary.files} files changed`}
              <span className="text-success">+{summary.additions}</span>
              <span className="text-destructive">−{summary.deletions}</span>
            </>
          )}
        </p>
      </div>
      <Button
        size="xs"
        variant="outline"
        data-testid="inbox-publish-review"
        aria-label={named ? `Review changes: ${title}` : undefined}
        onClick={onReview}
      >
        Review changes
      </Button>
    </li>
  );
}

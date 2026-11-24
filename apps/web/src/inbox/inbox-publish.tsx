import type { ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, FileDiff, Undo2, X } from "lucide-react";
import { useId } from "react";

import { useApi } from "@/api/context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/motion";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import type { InboxEntry } from "@/orchestration/inbox-model";
import { keptDiff } from "@/panels/kept-diff";
import { useThreadsStore } from "@/stores/threads";

import { publishSummaryOf } from "./inbox-publish-model";
import { rowAnswersBeside, useRowAnswers, type RowAnswer } from "./inbox-row-answers";

/**
 * Under an approval that would push a branch or open its pull request, what each asking thread
 * would publish: its branch against its base, in files and lines, and Review changes, which opens
 * the thread on its Diff. So the person can judge the change before allowing it, not after.
 */
export function InboxPublish({
  entries,
  onReview,
  onDecide,
}: {
  entries: readonly InboxEntry[];
  onReview: (threadId: ThreadId) => void;
  /** Answers one thread's request alone, which a group's Allow answers with the others. */
  onDecide: (entry: InboxEntry, decision: "allow" | "deny") => void;
}) {
  const several = entries.length > 1;
  const heading = useId();
  const all = useRowAnswers((s) => s.answers);
  const answered = rowAnswersBeside(
    all,
    entries.map((entry) => entry.request.id),
  );
  return (
    <section
      aria-labelledby={heading}
      data-testid="inbox-publish"
      className="mx-2 mt-5 flex flex-col gap-1.5 rounded-(--radius-md) border border-border px-3 py-2"
    >
      <h3 id={heading} className="text-meta text-muted-foreground">
        {several ? "What they would publish" : "What it would publish"}
      </h3>
      {several && (
        <p data-testid="inbox-publish-hint" className="text-meta text-muted-foreground">
          Decide each one on its row, or all {entries.length} at once with Allow {entries.length}{" "}
          above.
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <PublishRow
            key={entry.threadId}
            threadId={entry.threadId}
            title={entry.title}
            branch={entry.checkout?.branch}
            named={several || answered.length > 0}
            onReview={() => onReview(entry.threadId)}
            onDecide={several ? (decision) => onDecide(entry, decision) : undefined}
          />
        ))}
      </ul>
      {answered.length > 0 && (
        <ul
          aria-label="Decided on their own"
          className="flex flex-col gap-1 border-t border-border pt-1.5"
        >
          {answered.map((answer) => (
            <AnsweredRow key={answer.key} answer={answer} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AnsweredRow({ answer }: { answer: RowAnswer }) {
  const held = useAskStackStore((s) => s.held.some((h) => h.key === answer.key));
  const problem = useAskStackStore((s) => s.problems[answer.key]);
  const allowed = answer.decision === "allow";
  const Icon = allowed ? Check : X;
  return (
    <li
      data-testid="inbox-publish-answered"
      data-decision={answer.decision}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-meta"
    >
      <Icon
        aria-hidden
        className={allowed ? "size-icon-row text-success" : "size-icon-row text-muted-foreground"}
      />
      <span className="min-w-0 flex-1">
        <span className="text-foreground">
          {allowed ? "Allowed" : "Denied"}: {answer.title}.
        </span>{" "}
        <span className="text-muted-foreground">
          {problem ??
            (held
              ? "Goes to the worker in a few seconds."
              : allowed
                ? "It goes ahead with the push."
                : "It won't push; the worker was told.")}
        </span>
      </span>
      {held && (
        <Button
          size="xs"
          variant="ghost"
          data-testid="inbox-publish-undo"
          onClick={() => {
            if (useAskStackStore.getState().undo(answer.key) !== undefined) {
              useRowAnswers.getState().remove(answer.key);
            }
          }}
        >
          <Undo2 aria-hidden />
          Undo
        </Button>
      )}
    </li>
  );
}

function PublishRow({
  threadId,
  title,
  branch,
  named,
  onReview,
  onDecide,
}: {
  threadId: ThreadId;
  title: string;
  branch: string | undefined;
  named: boolean;
  onReview: () => void;
  onDecide: ((decision: "allow" | "deny") => void) | undefined;
}) {
  const api = useApi();
  const stamp = useThreadsStore((s) => {
    const git = s.byId[threadId]?.git;
    return git === undefined
      ? null
      : `${git.changesToken}:${git.base ?? ""}:${git.behindBase}:${git.aheadBase}`;
  });
  const diffKey = ["git.diff", threadId, "branch", null, stamp] as const;
  const query = useQuery({
    queryKey: [...diffKey, false],
    // The summary on screen stays while the tree's newer one is read: a worker at work moves its
    // stamp often, and "Reading its changes…" blinked in between each time.
    placeholderData: keptDiff(diffKey),
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
      <div className="flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          data-testid="inbox-publish-review"
          aria-label={named ? `Review changes: ${title}` : undefined}
          onClick={onReview}
        >
          Review changes
        </Button>
        {onDecide !== undefined && (
          <>
            <Button
              size="xs"
              variant="ghost"
              data-testid="inbox-publish-allow"
              aria-label={`Allow only ${title}`}
              onClick={() => onDecide("allow")}
            >
              Allow this one
            </Button>
            <Button
              size="xs"
              variant="ghost"
              data-testid="inbox-publish-deny"
              aria-label={`Deny only ${title}`}
              onClick={() => onDecide("deny")}
            >
              Deny this one
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

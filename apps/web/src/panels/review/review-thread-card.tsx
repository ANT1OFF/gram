import type { ReviewSeverity, ReviewThread, ThreadId } from "@gram/contracts";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "@/api/errors";
import type { Api } from "@/api/types";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { OutboundLink } from "../outbound-link";
import { addressThreadMessage, displayBody, location, SEVERITY_LABEL } from "./review-model";

export interface ReviewActions {
  api: Api;
  threadId: ThreadId;
  prNumber: number;
  refresh(): Promise<void>;
}

export interface NoticeState {
  tone: "ok" | "error";
  text: string;
}

/** Runs one action at a time, keeping its outcome as a short notice. */
export function useReviewAction() {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<NoticeState>();
  const run = async (action: () => Promise<string | undefined>) => {
    setPending(true);
    setNotice(undefined);
    try {
      const text = await action();
      if (text) setNotice({ tone: "ok", text });
    } catch (error) {
      setNotice({ tone: "error", text: errorMessage(error) });
    } finally {
      setPending(false);
    }
  };
  return { pending, notice, run };
}

export function Notice({ notice }: { notice: NoticeState | undefined }) {
  if (!notice) return null;
  return (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      className={cn(
        "text-xs",
        notice.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {notice.text}
    </p>
  );
}

const SEVERITY_TONE: Record<ReviewSeverity, string> = {
  blocker: "border-destructive/40 text-destructive",
  suggestion: "border-warning/40 text-warning",
  outstanding: "border-warning/40 text-warning",
  finding: "border-border text-muted-foreground",
};

export function ReviewThreadCard({
  thread,
  actions,
}: {
  thread: ReviewThread;
  actions: ReviewActions;
}) {
  const { api, threadId, prNumber, refresh } = actions;
  const action = useReviewAction();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [first, ...replies] = thread.comments;
  // A person's thread carries no severity tag; say who raised it instead.
  const severityLabel = thread.byBot ? SEVERITY_LABEL[thread.severity] : "Reviewer";
  const canApply = first?.suggestion !== undefined && !thread.isOutdated && !thread.isResolved;

  const apply = () =>
    action.run(async () => {
      const result = await api.prApplySuggestion(threadId, first!.id);
      return `Applied to ${result.path}:${result.startLine}-${result.endLine} (not committed)`;
    });
  const address = () =>
    action.run(async () => {
      const result = await api.send(threadId, { text: addressThreadMessage(prNumber, thread) });
      return result.queued ? "Queued for the agent" : "Sent to the agent";
    });
  const sendReply = () =>
    action.run(async () => {
      await api.prReplyThread(threadId, thread.id, reply.trim());
      setReplying(false);
      setReply("");
      await refresh();
      return "Reply posted";
    });
  const resolve = () =>
    action.run(async () => {
      await api.prResolveThread(threadId, thread.id);
      await refresh();
      return undefined;
    });

  return (
    <article
      data-testid="review-thread"
      data-severity={thread.severity}
      data-by-bot={thread.byBot}
      aria-label={`${severityLabel}: ${location(thread)}`}
      className="flex flex-col gap-1.5 rounded-(--radius-md) border border-border bg-card/40 p-2"
    >
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("shrink-0 rounded-sm border px-1", SEVERITY_TONE[thread.severity])}>
          {severityLabel}
        </span>
        {thread.line !== undefined && (
          <span className="font-mono">
            L
            {thread.startLine !== undefined && thread.startLine !== thread.line
              ? `${thread.startLine}-`
              : ""}
            {thread.line}
          </span>
        )}
        {thread.isOutdated && (
          <span className="rounded-sm border border-border px-1">Outdated</span>
        )}
        {first && <span className="min-w-0 truncate">{first.author}</span>}
        {first?.url && (
          <OutboundLink href={first.url} className="ml-auto shrink-0 hover:text-foreground">
            <ExternalLink aria-label="Open on GitHub" className="size-3" />
          </OutboundLink>
        )}
      </p>
      {first && <MessageResponse>{displayBody(first.body)}</MessageResponse>}
      {first?.suggestion !== undefined && (
        <figure data-testid="review-suggestion" className="text-xs">
          <figcaption className="mb-0.5 text-muted-foreground">
            {first.suggestion === "" ? "Suggests deleting these lines" : "Suggested change"}
          </figcaption>
          {first.suggestion !== "" && (
            <pre className="overflow-x-auto rounded-sm bg-muted p-1.5 font-mono text-[11px]">
              {first.suggestion}
            </pre>
          )}
        </figure>
      )}
      {replies.length > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-border pl-2">
          {replies.map((comment) => (
            <li key={comment.id} data-testid="review-reply" className="text-xs">
              <span className="font-medium">{comment.author}</span>
              <MessageResponse>{comment.body}</MessageResponse>
            </li>
          ))}
        </ul>
      )}
      {!thread.isResolved && (
        <div className="flex flex-wrap gap-1">
          {canApply && (
            <Button
              size="xs"
              variant="outline"
              disabled={action.pending}
              onClick={() => void apply()}
            >
              Apply suggestion
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={action.pending}
            onClick={() => void address()}
          >
            Ask agent to address
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={action.pending}
            aria-expanded={replying}
            onClick={() => setReplying((open) => !open)}
          >
            Reply…
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={action.pending}
            onClick={() => void resolve()}
          >
            Resolve
          </Button>
        </div>
      )}
      {replying && (
        <form
          className="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (reply.trim()) void sendReply();
          }}
        >
          <textarea
            aria-label="Reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={3}
            placeholder="Fixed in <sha>: …"
            className="w-full resize-y rounded-sm border border-border bg-background p-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex gap-1">
            <Button type="submit" size="xs" disabled={action.pending || !reply.trim()}>
              Send reply
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setReplying(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <Notice notice={action.notice} />
    </article>
  );
}

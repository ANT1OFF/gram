import type { ApprovalRequest, ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { useStableSelector } from "@/lib/use-stable";
import { cn } from "@/lib/utils";
import { briefTitle, type NeedsYouItem } from "@/orchestration/needs-you-items";
import { kindOf } from "@/orchestration/needs-you-row";
import { useNeedsYouJump, useNeedsYouList } from "@/orchestration/use-needs-you";
import { OutboundLink } from "@/panels/outbound-link";
import { useThreadFeed } from "@/stores/feeds";
import { REVIEW_STRIP_WIDTH, reviewStripWidth, useLayoutStore } from "@/stores/layout";
import type { ThreadFeedState } from "@/stores/thread-feed";
import { useThreadsStore } from "@/stores/threads";
import { RequestCards } from "@/thread/request-cards";

import { stripLines, type StripMark } from "./strip-text";

const BACK = "Back to the conversation";

/** The newest message with words in it, and whose: what the strip keeps readable. */
export const latestSaid = (
  messages: ThreadFeedState["messages"],
): { readonly role: "user" | "assistant"; readonly text: string } | undefined => {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at];
    if (message === undefined || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n\n")
      .trim();
    if (text !== "") return { role: message.role, text };
  }
  return undefined;
};

/**
 * What a review in focus leaves of the chat: a strip over it that keeps the conversation readable,
 * its title, any decision waiting on the user and the latest message, with the way back one click
 * (or Esc) away. An approval is answered here, on the card its thread shows, with the same verbs,
 * keys (1, 2, 3) and rules: the chat under the strip is covered and answers no key meanwhile. Any
 * other decision is answered in the conversation: the strip says what waits and takes the user
 * there. A window too narrow for that keeps a rail: the way back and the title down its length.
 */
export function ReviewStrip({ side }: { side: "left" | "right" }) {
  const windowWidth = useLayoutStore((s) => s.windowWidth);
  const threadId = useParams({ strict: false }).threadId as ThreadId | undefined;
  const width = reviewStripWidth(windowWidth);
  return (
    <div
      data-testid="review-strip"
      data-readable={width >= REVIEW_STRIP_WIDTH}
      className={cn(
        "absolute inset-y-0 z-20 flex flex-col bg-thread",
        side === "left" ? "left-0" : "right-0",
      )}
      style={{ width }}
    >
      <div className="h-(--titlebar-height) w-full shrink-0 [-webkit-app-region:drag]" />
      {width >= REVIEW_STRIP_WIDTH && threadId !== undefined ? (
        <ReadableStrip threadId={threadId} />
      ) : (
        <RailStrip threadId={threadId} />
      )}
    </div>
  );
}

function RailStrip({ threadId }: { threadId: ThreadId | undefined }) {
  const setReviewFocus = useLayoutStore((s) => s.setReviewFocus);
  const hint = useShortcutHint("panel.restore");
  const title = useThreadsStore((s) =>
    threadId === undefined ? undefined : s.byId[threadId]?.thread.title,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3 border-t border-border py-2">
      <Hint
        label={withHint(BACK, hint)}
        side="right"
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={BACK}
            className="shrink-0 text-muted-foreground"
            onClick={() => setReviewFocus(false)}
          />
        }
      >
        <MessageSquare />
      </Hint>
      {title && (
        <span className="min-h-0 truncate text-meta text-muted-foreground [writing-mode:vertical-rl]">
          {title}
        </span>
      )}
    </div>
  );
}

function ReadableStrip({ threadId }: { threadId: ThreadId }) {
  const setReviewFocus = useLayoutStore((s) => s.setReviewFocus);
  const hint = useShortcutHint("panel.restore");
  const title = useThreadsStore((s) => s.byId[threadId]?.thread.title);
  // Rebuilt on every streamed frame: kept while it says the same, so the store's snapshot is stable.
  const latest = useThreadFeed(
    threadId,
    useStableSelector(
      (s) => latestSaid(s.messages),
      (a, b) => a?.role === b?.role && a?.text === b?.text,
    ),
  );
  const approvals = useThreadsStore(
    useShallow((s) =>
      (s.byId[threadId]?.pendingRequests ?? []).filter(
        (request): request is ApprovalRequest => request.kind === "approval",
      ),
    ),
  );
  // The approvals' own cards answer them here; what else waits says so and leads to its card.
  const answeredHere = new Set<string>(approvals.map((request) => request.id));
  const waiting = useNeedsYouList().items.filter(
    (item) =>
      item.threadId === threadId &&
      !(item.ids.length > 0 && item.ids.every((id) => answeredHere.has(id))),
  );
  const jump = useNeedsYouJump();
  const answer = (item: NeedsYouItem) => {
    setReviewFocus(false);
    jump(item);
  };
  return (
    <div
      // The strip is where the thread's approval keys reach while its view is covered.
      data-approval-keys
      className="flex min-h-0 flex-1 flex-col border-t border-border"
    >
      <div className="flex shrink-0 items-start gap-2 px-3 pt-3 pb-2">
        <Hint
          label={withHint(BACK, hint)}
          side="right"
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={BACK}
              className="shrink-0 text-muted-foreground"
              onClick={() => setReviewFocus(false)}
            />
          }
        >
          <ArrowLeft />
        </Hint>
        {title && (
          <h2
            data-testid="review-strip-title"
            title={title}
            className="line-clamp-2 min-w-0 pt-1 text-body-strong text-pretty"
          >
            {title}
          </h2>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
        {/* Mounted with none left, so the receipt of an answer shows where its card was. */}
        <div data-testid="review-strip-approvals" className="-my-2 empty:hidden">
          <RequestCards threadId={threadId} requests={approvals} focused />
        </div>
        {waiting.length > 0 && (
          <ul aria-label="Waiting on you" className="flex flex-col gap-2">
            {waiting.map((item) => (
              <WaitingDecision key={item.key} item={item} onAnswer={() => answer(item)} />
            ))}
          </ul>
        )}
        {latest !== undefined && (
          <section data-testid="review-strip-latest" className="flex min-w-0 flex-col gap-1">
            <h3 className="text-meta text-muted-foreground">
              {latest.role === "user" ? "You said" : "Latest message"}
            </h3>
            <p className="line-clamp-[14] text-body break-words">
              <StripText text={latest.text} />
            </p>
          </section>
        )}
        <Button
          size="xs"
          variant="outline"
          data-testid="review-strip-open"
          className="self-start"
          onClick={() => setReviewFocus(false)}
        >
          Open conversation
        </Button>
      </div>
    </div>
  );
}

/**
 * A message's Markdown as the strip reads it: links as their (shortened) text that opens them,
 * code, bold and italics as marks, and line breaks kept; never the syntax itself.
 */
function StripText({ text }: { text: string }) {
  return stripLines(text).map((line, at) => (
    // Lines don't move: the message is rendered whole each time.
    // oxlint-disable-next-line react/no-array-index-key
    <Fragment key={at}>
      {at > 0 && <br />}
      {line.map(renderMark)}
    </Fragment>
  ));
}

const renderMark = (mark: StripMark, at: number): ReactNode => {
  switch (mark.kind) {
    case "text":
      return mark.text;
    case "code":
      return (
        <code key={at} className="rounded-(--radius-sm) bg-muted/50 px-1 font-mono text-meta">
          {mark.text}
        </code>
      );
    case "strong":
      return (
        <strong key={at} className="font-medium">
          {mark.marks.map(renderMark)}
        </strong>
      );
    case "em":
      return <em key={at}>{mark.marks.map(renderMark)}</em>;
    case "link":
      return (
        <OutboundLink
          key={at}
          href={mark.href}
          title={mark.href}
          untrusted
          className="rounded-sm text-link underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {mark.text}
        </OutboundLink>
      );
  }
};

/** A decision waiting in the thread: what it is, and the way to its card in the conversation. */
function WaitingDecision({ item, onAnswer }: { item: NeedsYouItem; onAnswer: () => void }) {
  const kind = kindOf(item);
  return (
    <li
      data-testid="review-strip-waiting"
      className="flex flex-col gap-2 rounded-(--radius-md) border border-status-needs-mark bg-card p-2"
    >
      <p className="flex items-center gap-1.5 text-meta text-status-needs">
        <kind.icon aria-hidden className="size-icon-chip shrink-0" />
        {kind.label}
      </p>
      <p className="text-body text-pretty">{briefTitle(item)}</p>
      {item.command !== undefined && (
        <p className="line-clamp-3 font-mono text-meta break-all text-muted-foreground">
          {item.command}
        </p>
      )}
      <Button size="xs" variant="outline" className="self-start" onClick={onAnswer}>
        Answer in the conversation
      </Button>
    </li>
  );
}

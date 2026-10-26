import type { MessageOrigin } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MessagesSquare } from "lucide-react";
import type { ReactNode } from "react";

import { AgentIcon } from "@/agents/agent-display";
import { MessageContent } from "@/components/ai-elements/message";
import { useThreadsStore } from "@/stores/threads";

/**
 * What the sender is to the workspace, when it is anything: its orchestrator, or a worker. A worker
 * since removed still sent as one, which its origin's feature says.
 */
const senderRole = (origin: MessageOrigin, spawned: boolean) =>
  origin.role === "orchestrator"
    ? "orchestrator"
    : spawned || origin.feature !== undefined
      ? "worker"
      : undefined;

const DELIVERY = {
  steer: { label: "steer", hint: "Sent to steer the running turn" },
  queue: { label: "queued", hint: "Queued for after the turn" },
} as const;

/** The sender's mark: its agent's, or a plain one once the app no longer has the thread. */
function SenderAvatar({ agent }: { agent: string | undefined }) {
  return (
    <span
      aria-hidden
      data-testid="message-origin-avatar"
      className="flex size-5 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-foreground"
    >
      {agent === undefined ? (
        <MessagesSquare className="size-3" />
      ) : (
        <AgentIcon agent={agent} className="size-3" />
      )}
    </span>
  );
}

/**
 * The line over a message another thread sent (`send_message`): the sender's avatar and name, its
 * role and how it asked to be delivered. The whole line opens the sender's thread, under its
 * current title; once that thread is gone it is the title it sent under, muted and not a link.
 */
export function MessageOriginLabel({ origin }: { origin: MessageOrigin }) {
  const sender = useThreadsStore((s) => s.byId[origin.threadId]?.thread);
  const ready = useThreadsStore((s) => s.ready);
  const gone = ready && sender === undefined;
  const role = senderRole(origin, sender?.spawnedBy !== undefined);
  // Absent, it was left to the default, which queues.
  const delivery = DELIVERY[origin.mode ?? "queue"];
  const body = (
    <>
      <SenderAvatar agent={sender?.model.agent} />
      <span className="sr-only">Received from </span>
      <span
        className={
          gone ? "truncate line-through" : "truncate font-medium text-foreground underline-offset-4"
        }
      >
        {sender?.title ?? origin.title}
      </span>
      {role !== undefined && <span className="shrink-0">· {role}</span>}
      <span className="shrink-0" title={delivery.hint}>
        · {delivery.label}
      </span>
      {!gone && (
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 transition-transform group-hover/origin:translate-x-0.5"
        />
      )}
    </>
  );
  const row =
    "flex w-fit max-w-full min-w-0 items-center gap-1.5 text-xs whitespace-normal text-muted-foreground";
  if (gone) {
    return (
      <p data-testid="message-origin" title="Thread not found" className={row}>
        {body}
      </p>
    );
  }
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: origin.threadId }}
      data-testid="message-origin"
      className={`group/origin ${row} rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover>span.truncate]:underline`}
    >
      {body}
    </Link>
  );
}

/**
 * A message another thread sent, on the agents' side of the transcript rather than in the user's
 * bubble: the sender's line, then its words in a quiet box. Gram fences the same words for the
 * agent as the sender's, so neither reads them as the user's.
 */
export function ThreadMessage({
  origin,
  children,
}: {
  origin: MessageOrigin;
  children: ReactNode;
}) {
  return (
    <div data-testid="message-thread" className="flex max-w-full min-w-0 flex-col gap-1">
      <MessageOriginLabel origin={origin} />
      <MessageContent className="ml-6.5 rounded-lg border border-border bg-card/40 px-3 py-2 whitespace-pre-wrap">
        {children}
      </MessageContent>
    </div>
  );
}

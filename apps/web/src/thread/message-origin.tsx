import { useEmbedShell } from "@/embed/store";
import type { AskedBy, MessageOrigin } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { useEffect, useId, type ReactNode } from "react";
import { create } from "zustand";

import { AgentIcon } from "@/agents/agent-display";
import { MessageContent } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { useRevealStore } from "@/stores/reveal";
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
  interrupt: { label: "interrupt", hint: "Sent to stop the running turn and be answered now" },
  steer: { label: "steer", hint: "Sent into the running turn, after its tool calls finish" },
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
        <MessagesSquare className="size-icon-row" />
      ) : (
        <AgentIcon agent={agent} className="size-icon-chip" />
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
  // A sender the embedding app shows in a place of its own is named by that place, and opens there.
  const place = useEmbedShell((s) =>
    s.threadsPage.places?.find((each) => each.ids.includes(origin.threadId)),
  );
  const role = place?.name ?? senderRole(origin, sender?.spawnedBy !== undefined);
  // Absent only on a message sent before every send carried its mode, when the default queued.
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
          className="size-icon-chip shrink-0 transition-transform group-hover/origin:translate-x-0.5"
        />
      )}
    </>
  );
  const row =
    "flex w-fit max-w-full min-w-0 items-center gap-1.5 text-meta whitespace-normal text-muted-foreground";
  if (gone) {
    return (
      <p data-testid="message-origin" title="Thread not found" className={row}>
        {body}
      </p>
    );
  }
  if (place !== undefined) {
    const to = place.path.replace("$threadId", encodeURIComponent(origin.threadId));
    return (
      <Link
        {...({ to } as unknown as { to: "/" })}
        data-testid="message-origin"
        data-place={place.name}
        className={`group/origin ${row} rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover>span.truncate]:underline`}
      >
        {body}
      </Link>
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
 * "sent from Chat": the thread outside the workspace that asked for a worker, on the orchestrator's
 * brief. Named and opened as the place the embedding app shows it in, if any; else under its
 * current title. Once that thread is gone, its title then, not a link.
 */
export function AskedByLink({ askedBy }: { askedBy: AskedBy }) {
  const asker = useThreadsStore((s) => s.byId[askedBy.threadId]?.thread);
  const ready = useThreadsStore((s) => s.ready);
  const place = useEmbedShell((s) =>
    s.threadsPage.places?.find((each) => each.ids.includes(askedBy.threadId)),
  );
  const name = place?.name ?? asker?.title ?? askedBy.title;
  const words = (
    <>
      sent from <span className="font-medium text-foreground">{name}</span>
    </>
  );
  const quiet = "shrink-0 text-meta text-muted-foreground";
  if (place === undefined && ready && asker === undefined) {
    return (
      <span data-testid="message-asked-by" title="Thread not found" className={quiet}>
        · {words}
      </span>
    );
  }
  const link = `${quiet} rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`;
  return (
    <span className={quiet}>
      ·{" "}
      {place === undefined ? (
        <Link
          to="/t/$threadId"
          params={{ threadId: askedBy.threadId }}
          data-testid="message-asked-by"
          className={link}
        >
          {words}
        </Link>
      ) : (
        <Link
          {...({
            to: place.path.replace("$threadId", encodeURIComponent(askedBy.threadId)),
          } as unknown as { to: "/" })}
          data-testid="message-asked-by"
          data-place={place.name}
          className={link}
        >
          {words}
        </Link>
      )}
    </span>
  );
}

interface OpenBriefs {
  readonly open: ReadonlySet<string>;
  toggle(messageId: string): void;
  /** Opens one a search is about to land in, and leaves one that's open alone. */
  reveal(messageId: string): void;
}

/**
 * The orchestrator's messages a reader opened, by message id. Here rather than in the row, which
 * the transcript's list unmounts on scroll and on leaving the thread, and only while the app is open.
 */
const useOpenBriefs = create<OpenBriefs>()((set) => ({
  open: new Set(),
  reveal: (messageId) =>
    set((s) => (s.open.has(messageId) ? s : { open: new Set(s.open).add(messageId) })),
  toggle: (messageId) =>
    set((s) => {
      const open = new Set(s.open);
      if (!open.delete(messageId)) open.add(messageId);
      return { open };
    }),
}));

/** The first line of a message, for its folded row. */
const firstLine = (text: string) => text.trimStart().split("\n", 1)[0] ?? "";

/**
 * A message another thread sent, on the agents' side of the transcript rather than in the user's
 * bubble: the sender's line, then its words in a quiet box. Gram fences the same words for the
 * agent as the sender's, so neither reads them as the user's. The orchestrator's (a worker's brief,
 * and what it says to the worker later) folds to one line, its words a click away.
 */
export function ThreadMessage({
  origin,
  messageId,
  text,
  children,
}: {
  origin: MessageOrigin;
  /** The message's id, which keeps it open across scrolls; absent, it never folds. */
  messageId?: string | undefined;
  /** Its words as plain text, for the folded line. */
  text?: string | undefined;
  children: ReactNode;
}) {
  if (origin.role === "orchestrator" && messageId !== undefined) {
    return (
      <OrchestratorMessage origin={origin} messageId={messageId} text={text ?? ""}>
        {children}
      </OrchestratorMessage>
    );
  }
  return (
    <div data-testid="message-thread" className="flex max-w-full min-w-0 flex-col gap-1">
      <MessageOriginLabel origin={origin} />
      <MessageContent className="ml-6.5 rounded-lg border border-edge bg-card/40 px-3 py-2 whitespace-pre-wrap">
        {children}
      </MessageContent>
    </div>
  );
}

/**
 * "Message from orchestrator ▸", with the start of its words: the orchestrator's message to a
 * worker, folded so the worker's own work leads the transcript. A click opens it, and a search that
 * lands in it opens it too. The worker's header already links to its orchestrator.
 */
function OrchestratorMessage({
  origin,
  messageId,
  text,
  children,
}: {
  origin: MessageOrigin;
  messageId: string;
  text: string;
  children: ReactNode;
}) {
  const toggled = useOpenBriefs((s) => s.open.has(messageId));
  const toggle = useOpenBriefs((s) => s.toggle);
  const revealed = useRevealStore((s) => s.request?.messageId === messageId);
  const open = toggled || revealed;
  // Kept open once the search's flash is over.
  useEffect(() => {
    if (revealed) useOpenBriefs.getState().reveal(messageId);
  }, [revealed, messageId]);
  const sender = useThreadsStore((s) => s.byId[origin.threadId]?.thread);
  const body = useId();
  const delivery = DELIVERY[origin.mode ?? "queue"];
  return (
    <div
      data-testid="message-thread"
      data-folded={open ? undefined : ""}
      className="flex w-full max-w-full min-w-0 flex-col gap-1"
    >
      <div className="flex w-full min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={body}
          data-testid="orchestrator-message-toggle"
          onClick={() => toggle(messageId)}
          className="group/brief flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <SenderAvatar agent={sender?.model.agent} />
          <span className="shrink-0 font-medium text-foreground">Message from orchestrator</span>
          <span className="shrink-0" title={delivery.hint}>
            · {delivery.label}
          </span>
          <ChevronRight
            aria-hidden
            className={cn(
              "size-icon-chip shrink-0 transition-transform duration-(--dur-fast)",
              open && "rotate-90",
            )}
          />
          {!open && <span className="min-w-0 truncate">{firstLine(text)}</span>}
        </button>
        {origin.askedBy !== undefined && <AskedByLink askedBy={origin.askedBy} />}
      </div>
      {open && (
        <MessageContent
          id={body}
          className="ml-6.5 rounded-lg border border-edge bg-card/40 px-3 py-2 whitespace-pre-wrap"
        >
          {children}
        </MessageContent>
      )}
    </div>
  );
}

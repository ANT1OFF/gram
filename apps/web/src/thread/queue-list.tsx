import type { MessageOrigin, QueuedInput, ThreadId, ThreadStatus } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowDown,
  ArrowUp,
  ListOrdered,
  MessagesSquare,
  Paperclip,
  Pencil,
  Send,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { agentLabel } from "@/agents/agent-display";
import { useApi } from "@/api/context";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PresenceItem, PresenceList } from "@/motion";
import { queueOps, useThreadsStore } from "@/stores/threads";

import { ROLE_ICON } from "./role-chip";

const EMPTY: readonly QueuedInput[] = [];

const run = (op: Promise<void>) => void op.catch((error: unknown) => console.error("queue", error));

/** What a queued message's Steer button says, enabled. */
export const STEER_LABEL = "Steer now: deliver before the turn ends";

/** What the same button says with no turn running, when pressing it sends the message now. */
export const SEND_NOW_LABEL = "Send now: no turn is running";

/** Statuses with no turn for a queued message to wait on, where its button sends it. */
const NOTHING_RUNNING: ReadonlySet<ThreadStatus> = new Set(["idle", "error", "cold"]);

/** What a queued message's button says, enabled. */
const queueSendLabel = (status: ThreadStatus | undefined): string =>
  status !== undefined && NOTHING_RUNNING.has(status) ? SEND_NOW_LABEL : STEER_LABEL;

/**
 * Why a queued message can't go into the thread now, or `undefined` when it can. A running turn
 * takes one only from an agent that reads input mid-turn; with no turn running, it is sent.
 */
export const steerBlocked = (
  status: ThreadStatus | undefined,
  steer: boolean | undefined,
  agent: string | undefined,
): string | undefined => {
  if (status !== undefined && NOTHING_RUNNING.has(status)) return undefined;
  if (steer !== true) {
    return `${agent === undefined ? "This agent" : agentLabel(agent)} can't take a message mid-turn, so this one waits for the turn to end`;
  }
  if (status === "running") return undefined;
  if (status === "needsApproval" || status === "needsInput") {
    return "The turn is waiting on you: steer once it's running again";
  }
  return "No turn is running to steer into";
};

/** Why another thread's message sits in the queue, as the card's byline puts it. */
const queuedBecause = (origin: MessageOrigin): string | undefined =>
  origin.mode === "queue"
    ? "queued as context"
    : origin.mode === "steer"
      ? "queued, as it couldn't be steered"
      : undefined;

function AttachmentCount({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span
      aria-label={`${n} attachment${n === 1 ? "" : "s"}`}
      className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-xs text-muted-foreground"
    >
      <Paperclip aria-hidden className="size-3" />
      {n}
    </span>
  );
}

/** Names the thread that queued a message and why, linking back to it; the user's own have none. */
function QueuedFrom({ origin }: { origin: MessageOrigin }) {
  const Icon = origin.role === "orchestrator" ? ROLE_ICON.orchestrator : MessagesSquare;
  const because = queuedBecause(origin);
  return (
    <p
      data-testid="queue-origin"
      className="mb-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
    >
      <Icon aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">From</span>
      <Link
        to="/t/$threadId"
        params={{ threadId: origin.threadId }}
        className="truncate font-medium text-foreground underline-offset-4 hover:underline"
      >
        {origin.title}
      </Link>
      {because !== undefined && <span className="shrink-0">· {because}</span>}
    </p>
  );
}

const FADE = "1.25rem";

/**
 * A box of capped height that scrolls, its edge fading while there is more past it. The queue, and
 * each message in it, sit in one: a long message, or several joined, once grew the card until it
 * pushed the composer off the pane and clipped the text with it.
 */
function ScrollFade({
  className,
  children,
  ...data
}: {
  className: string;
  children: ReactNode;
  [data: `data-${string}`]: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null) return;
    const measure = () => {
      const above = el.scrollTop > 0;
      // A pixel of slack: a fractional height can leave the end a hair short of `scrollHeight`.
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((was) => (was.above === above && was.below === below ? was : { above, below }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // The box stops growing at its cap, so it's what is inside that says when there's more.
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    resize?.observe(el);
    if (body.current !== null) resize?.observe(body.current);
    return () => {
      el.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, []);
  const mask =
    edges.above || edges.below
      ? `linear-gradient(to bottom, transparent, #000 ${edges.above ? FADE : "0px"}, #000 calc(100% - ${edges.below ? FADE : "0px"}), transparent)`
      : undefined;
  return (
    <div
      ref={box}
      {...data}
      data-more-above={edges.above || undefined}
      data-more-below={edges.below || undefined}
      className={cn("overflow-y-auto overscroll-contain", className)}
      style={mask === undefined ? undefined : { maskImage: mask }}
    >
      <div ref={body}>{children}</div>
    </div>
  );
}

/** Messages waiting for the current turn to end; editable until they're sent. */
export function QueueList({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const queue = useThreadsStore((s) => s.byId[threadId]?.queue ?? EMPTY);
  // Agents that buffer mid-turn input until the turn ends are doing what the queue already does.
  const blocked = useThreadsStore((s) => {
    const summary = s.byId[threadId];
    return steerBlocked(summary?.status, summary?.capabilities?.steer, summary?.thread.model.agent);
  });
  const sendLabel = useThreadsStore((s) => queueSendLabel(s.byId[threadId]?.status));
  const [editing, setEditing] = useState<{ id: string; text: string }>();

  const getState = useThreadsStore.getState;

  // The section folds in with the first message and away with the last, and each message does the
  // same between, so the composer under it slides rather than jumps.
  return (
    <PresenceList>
      {queue.length > 0 && (
        <PresenceItem key="queue" className="my-2">
          <section data-testid="queue" aria-label="Queued messages" className="space-y-1 text-sm">
            <h3 className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListOrdered aria-hidden className="size-3.5" />
              Queued · sent when the turn ends
            </h3>
            <ScrollFade
              data-testid="queue-scroll"
              className="max-h-[min(24rem,32vh,calc(var(--pane-height,100vh)*0.25))]"
            >
              <ol className="space-y-1">
                <PresenceList>
                  {queue.map((item, index) => (
                    <PresenceItem
                      as="li"
                      glide
                      key={item.id}
                      data-testid="queue-item"
                      className="@container rounded-(--radius-sm) border border-border bg-card/40 px-2 py-1"
                    >
                      {/* In a narrow pane the controls go above the text rather than squeeze it
                          out, or sit below a screenful of it. */}
                      <div className="flex items-start gap-2 @max-xs:flex-col-reverse @max-xs:items-stretch @max-xs:gap-0">
                        {editing?.id === item.id ? (
                          <form
                            className="flex flex-1 flex-col gap-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              run(
                                queueOps.edit(api, getState, threadId, item.id, {
                                  ...item.input,
                                  text: editing.text,
                                }),
                              );
                              setEditing(undefined);
                            }}
                          >
                            <textarea
                              aria-label="Edit queued message"
                              className="max-h-[min(16rem,40vh)] min-h-12 w-full rounded-(--radius-sm) border border-input bg-transparent p-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              value={editing.text}
                              onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
                            />
                            <div className="flex gap-1">
                              <Button type="submit" size="xs">
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                onClick={() => setEditing(undefined)}
                              >
                                Cancel
                              </Button>
                            </div>
                          </form>
                        ) : (
                          <>
                            <div className="min-w-0 flex-1">
                              {item.input.origin && <QueuedFrom origin={item.input.origin} />}
                              <ScrollFade
                                data-testid="queue-text"
                                className="max-h-[min(8rem,20vh,calc(var(--pane-height,100vh)*0.2))] whitespace-pre-wrap wrap-anywhere"
                              >
                                {item.input.text}
                                <AttachmentCount n={item.input.attachments?.length ?? 0} />
                              </ScrollFade>
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center justify-end">
                              <Hint
                                label={blocked ?? sendLabel}
                                render={
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    data-testid="queue-steer"
                                    aria-label={
                                      blocked === undefined ? sendLabel : `Steer now (${blocked})`
                                    }
                                    disabled={blocked !== undefined}
                                    focusableWhenDisabled
                                    className={cn(blocked !== undefined && "opacity-50")}
                                    onClick={() =>
                                      run(queueOps.steer(api, getState, threadId, item.id))
                                    }
                                  />
                                }
                              >
                                <Send />
                              </Hint>
                              <Hint
                                label="Move up"
                                render={
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label="Move up"
                                    disabled={index === 0}
                                    onClick={() =>
                                      run(queueOps.move(api, getState, threadId, item.id, -1))
                                    }
                                  />
                                }
                              >
                                <ArrowUp />
                              </Hint>
                              <Hint
                                label="Move down"
                                render={
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label="Move down"
                                    disabled={index === queue.length - 1}
                                    onClick={() =>
                                      run(queueOps.move(api, getState, threadId, item.id, 1))
                                    }
                                  />
                                }
                              >
                                <ArrowDown />
                              </Hint>
                              <Hint
                                label="Edit"
                                render={
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label="Edit"
                                    onClick={() =>
                                      setEditing({ id: item.id, text: item.input.text })
                                    }
                                  />
                                }
                              >
                                <Pencil />
                              </Hint>
                              <Hint
                                label="Remove"
                                render={
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label="Remove"
                                    onClick={() =>
                                      run(queueOps.remove(api, getState, threadId, item.id))
                                    }
                                  />
                                }
                              >
                                <X />
                              </Hint>
                            </div>
                          </>
                        )}
                      </div>
                    </PresenceItem>
                  ))}
                </PresenceList>
              </ol>
            </ScrollFade>
          </section>
        </PresenceItem>
      )}
    </PresenceList>
  );
}

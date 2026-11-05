import type { ThreadId } from "@gram/contracts";
import { FileDiff } from "lucide-react";
import { useMemo } from "react";

import { agentLabel } from "@/agents/agent-label";
import { Spinner } from "@/motion";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { inboxContextOf } from "./inbox-context-model";

/**
 * Under the Inbox's item, what its thread said last and what its edits changed (`inboxContextOf`),
 * so the item can be answered without opening the thread. Read from the thread's own feed, held
 * open while the item is shown; nothing when the thread has said nothing yet.
 */
export function InboxContext({ threadId }: { threadId: ThreadId }) {
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const phase = useThreadFeed(threadId, (s) => s.phase);
  const agent = useThreadsStore((s) => s.byId[threadId]?.thread.model.agent);
  const context = useMemo(() => inboxContextOf(messages), [messages]);
  const empty = context.turns.length === 0 && context.files === 0;
  if (empty && phase !== "loading") return null;
  const speaker = agent === undefined ? "Agent" : agentLabel(agent);
  return (
    <section
      aria-label="Recent in the thread"
      data-testid="inbox-context"
      className="mx-2 mt-4 flex flex-col gap-2 border-t border-border px-2 pt-3"
    >
      <h3 className="flex items-center gap-2 text-meta text-muted-foreground">
        Recent in the thread
        {empty && <Spinner aria-hidden className="size-icon-chip" />}
      </h3>
      {context.files > 0 && (
        <p
          data-testid="inbox-context-changes"
          className="flex items-center gap-1.5 text-meta text-muted-foreground tabular-nums"
        >
          <FileDiff aria-hidden className="size-icon-row shrink-0" />
          {context.files === 1 ? "1 file changed" : `${context.files} files changed`}
          <span className="text-success">+{context.additions}</span>
          <span className="text-destructive">−{context.deletions}</span>
        </p>
      )}
      {context.turns.length > 0 && (
        <ol className="flex flex-col gap-2">
          {context.turns.map((turn) => (
            <li
              key={turn.id}
              data-testid="inbox-context-turn"
              data-role={turn.role}
              className="flex flex-col gap-0.5"
            >
              <span className="text-meta text-muted-foreground">
                {turn.role === "user" ? "You" : speaker}
              </span>
              <p className="line-clamp-3 text-body break-words">{turn.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

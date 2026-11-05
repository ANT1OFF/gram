import type { ThreadId } from "@gram/contracts";
import { ArrowDown } from "lucide-react";
import { createContext, use, useMemo, type ReactNode } from "react";

import { attr, ringWhenDrawn } from "@/lib/ring-when-drawn";
import { useRequestRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import type { ToolPhase } from "./parts";

/**
 * The tool calls of a thread held at an approval card, by call id. The agent reports such a call as
 * started (`input-available`) before it asks, so without this its row said Running while nothing
 * had run. Empty outside a transcript.
 */
const AwaitingToolsContext = createContext<ReadonlySet<string>>(new Set());

/**
 * Which approval request holds each waiting call, and the thread they are in: a waiting row links to
 * its card above the composer, which can sit far below it in a short transcript.
 */
const AwaitingRequestsContext = createContext<{
  threadId: ThreadId | undefined;
  requests: ReadonlyMap<string, string>;
}>({ threadId: undefined, requests: new Map() });

const NONE: ReadonlySet<string> = new Set();

export function AwaitingToolsProvider({
  threadId,
  children,
}: {
  threadId: ThreadId;
  children: ReactNode;
}) {
  // Keyed by the ids alone, so a card's other changes don't re-render every tool row.
  const key = useThreadsStore((s) =>
    (s.byId[threadId]?.pendingRequests ?? [])
      .flatMap((request) =>
        request.kind === "approval" && request.toolUseId !== undefined
          ? [`${request.toolUseId}\t${request.id}`]
          : [],
      )
      .join("\n"),
  );
  const pairs = useMemo(
    () => (key === "" ? [] : key.split("\n").map((line) => line.split("\t") as [string, string])),
    [key],
  );
  const ids = useMemo(
    () => (pairs.length === 0 ? NONE : new Set(pairs.map(([tool]) => tool))),
    [pairs],
  );
  const requests = useMemo(() => ({ threadId, requests: new Map(pairs) }), [threadId, pairs]);
  return (
    <AwaitingToolsContext value={ids}>
      <AwaitingRequestsContext value={requests}>{children}</AwaitingRequestsContext>
    </AwaitingToolsContext>
  );
}

export const useAwaitingTools = () => use(AwaitingToolsContext);

/**
 * Shows the approval card that holds a waiting call: its queue turns to it, and it is scrolled to,
 * ringed and focused, as a Needs you jump does. Undefined when no card holds the call.
 */
export function useShowApproval(toolCallId: string | undefined): (() => void) | undefined {
  const { threadId, requests } = use(AwaitingRequestsContext);
  const requestId = toolCallId === undefined ? undefined : requests.get(toolCallId);
  if (threadId === undefined || requestId === undefined) return undefined;
  return () => {
    useRequestRevealStore.getState().reveal(threadId, requestId);
    ringWhenDrawn(`[data-request-id="${attr(requestId)}"]`, true);
  };
}

/**
 * A call's phase with its pending approval taken into account: a call the agent started but is
 * still asking about waits on the user, whatever its own state says. Settled phases stand.
 */
export const withApproval = (
  phase: ToolPhase,
  toolCallId: string,
  awaiting: ReadonlySet<string>,
): ToolPhase =>
  (phase === "running" || phase === "pending") && awaiting.has(toolCallId) ? "awaiting" : phase;

/**
 * "Waiting for your approval", as a link down to the card that decides it: in a short transcript
 * the card sits above the composer, far from the row that waits on it.
 */
export function ApprovalLink({ onShow, label }: { onShow: () => void; label: string }) {
  return (
    <button
      type="button"
      data-testid="approval-link"
      onClick={onShow}
      className="flex shrink-0 items-center gap-1 rounded-sm text-meta text-status-needs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ArrowDown aria-hidden className="size-3.5" />
    </button>
  );
}

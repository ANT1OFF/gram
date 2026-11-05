import type { ThreadId } from "@gram/contracts";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useThreadsStore } from "@/stores/threads";

import type { ToolPhase } from "./parts";

/**
 * The tool calls of a thread held at an approval card, by call id. The agent reports such a call as
 * started (`input-available`) before it asks, so without this its row said Running while nothing
 * had run. Empty outside a transcript.
 */
const AwaitingToolsContext = createContext<ReadonlySet<string>>(new Set());

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
        request.kind === "approval" && request.toolUseId !== undefined ? [request.toolUseId] : [],
      )
      .join("\n"),
  );
  const ids = useMemo(() => (key === "" ? NONE : new Set(key.split("\n"))), [key]);
  return <AwaitingToolsContext value={ids}>{children}</AwaitingToolsContext>;
}

export const useAwaitingTools = () => use(AwaitingToolsContext);

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

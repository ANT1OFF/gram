import type { GramUIMessage, ModelRef, Thread, WorkspaceState } from "@gram/contracts";

import type { MockOrchestrationHost } from "./mock-orchestration";

const SERVER_IN_ERROR_DETAIL =
  "The orchestrator thread is in error. Open it to see why, then resume; Gram also tries again by itself from time to time.";

/**
 * A fresh session that didn't open (`gram.mock.handoffFails`), as the server leaves it: the
 * orchestrator in error with the checkout's reason, and its notice. Resolves to the workspace paused.
 */
export const failHandoff = (
  host: Pick<MockOrchestrationHost, "replace" | "setStatus" | "emit">,
  orchestrator: Thread,
  state: WorkspaceState,
): WorkspaceState => {
  host.replace({
    ...orchestrator,
    lastError: {
      kind: "unknown",
      retryable: true,
      text: "Claude Code couldn't start: the checkout at ~/code/api already has changes of its own (2 files), so the orchestrator's saved work wasn't put back.",
      at: Date.now(),
    },
  });
  host.setStatus(orchestrator.id, "error");
  host.emit({
    type: "notify",
    kind: "needsInput",
    title: `Orchestration paused: the orchestrator couldn't be reached (${state.workspace.name})`,
    body: SERVER_IN_ERROR_DETAIL,
    threadId: orchestrator.id,
  });
  return {
    ...state,
    paused: { reason: "deliveryFailed", detail: SERVER_IN_ERROR_DETAIL, at: Date.now() },
  };
};

/** Resuming after `failHandoff`: the orchestrator's next session opens. */
export const clearHandoffFailure = (
  host: Pick<MockOrchestrationHost, "replace" | "setStatus">,
  orchestrator: Thread | undefined,
): void => {
  if (orchestrator?.lastError === undefined) return;
  const { lastError: _, ...cleared } = orchestrator;
  host.replace(cleared);
  host.setStatus(cleared.id, "idle");
};

/** What a fresh session that opened leaves in the orchestrator's transcript, as the server writes it. */
export const handoffParts = (
  current: Thread,
  options: { readonly unsaved: boolean; readonly onto: ModelRef | undefined; readonly id: string },
): GramUIMessage["parts"] => {
  const { unsaved, onto } = options;
  return [
    ...(unsaved ? [] : [{ type: "text" as const, text: "ready" }]),
    {
      type: "data-handoff",
      id: options.id,
      data: {
        ...(current.agentSessionId === undefined
          ? {}
          : { previousAgentSessionId: current.agentSessionId }),
        reason: "user",
        ...(unsaved ? { unsaved: true } : {}),
        ...(onto === undefined
          ? {}
          : {
              agent: onto.agent,
              model: onto.model,
              previousAgent: current.model.agent,
              previousModel: current.model.model,
            }),
        at: Date.now(),
      },
    },
  ];
};

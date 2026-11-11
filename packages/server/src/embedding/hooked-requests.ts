// Which of an agent session's approval requests the decision hook is asked about, and with what.
//
// A session under the hook opens with the outward gate at `all` and its connectors gated
// (`hookedSessionOptions`), so every push, pull request command and connector call reaches the
// server as an approval request whatever the thread's mode. Those go to the hook before any
// card: allowed ones are answered for the agent, refused ones are denied with the reason, and
// only the ones it says to ask about become a card.

import { outwardActions, type OpenSessionOptions } from "@gram/agents";
import type { ApprovalRequest, DecisionAction, RequestId, ThreadId } from "@gram/contracts";
import type { DecisionQuestion } from "./decision-hook.ts";

/** One thing a request does that the hook is asked about. */
export type RequestAction = Pick<DecisionQuestion, "action" | "detail">;

/** Tools that run a command line, across the agents' names for them. */
const SHELL_TOOL = /^(?:bash|shell|exec_command|local_shell|command)$/i;

/** Gram's own MCP server, whose tools have their own gate (`app-tools/registry.ts`). */
const APP_TOOLS_SERVER = "gram";

/**
 * What the hook is asked about `request`: each outward thing its command line does, or the
 * connector call it is. Empty for anything else, which stays an ordinary card.
 */
export const requestActions = (
  request: Pick<ApprovalRequest, "toolName" | "input">,
): ReadonlyArray<RequestAction> => {
  if (request.toolName.startsWith("mcp__")) {
    const rest = request.toolName.slice("mcp__".length);
    const at = rest.indexOf("__");
    if (at <= 0) return [];
    const [server, tool] = [rest.slice(0, at), rest.slice(at + 2)];
    // Gram's own tools never have `__` in their names; a connector named `gram__x` is not one.
    if (server === APP_TOOLS_SERVER && !tool.includes("__")) return [];
    return [
      {
        action: "connector.call",
        detail: { server, tool, input: request.input, toolName: request.toolName },
      },
    ];
  }
  const command = request.input["command"];
  if (!SHELL_TOOL.test(request.toolName) || typeof command !== "string") return [];
  const actions: ReadonlyArray<DecisionAction> = outwardActions(command) ?? ["outward"];
  return actions.map((action) => ({ action, detail: { command } }));
};

/** What a session opens with while the hook is on, over what its thread's policy gave it. */
export const hookedSessionOptions: Pick<OpenSessionOptions, "outwardGate" | "gateConnectors"> = {
  outwardGate: "all",
  gateConnectors: true,
};

/** A card the hook sent to a person, kept so its approval is put to the hook again. */
export interface AskedRequest {
  readonly threadId: ThreadId;
  /** The actions an approval is put to the hook about again, each with its first call's id. */
  readonly actions: ReadonlyArray<RequestAction & { readonly decisionId: string }>;
}

/** The requests the hook is deciding, and the ones it sent to a person, across all threads. */
export interface HookedRequests {
  /** Requests put to the hook and not yet answered or made a card, with their threads. */
  readonly deciding: Map<RequestId, ThreadId>;
  readonly asked: Map<RequestId, AskedRequest>;
  /** A thread's requests were withdrawn (its turn stopped, its session went): forget them. */
  readonly forget: (threadId: ThreadId) => void;
}

export const makeHookedRequests = (): HookedRequests => {
  const deciding = new Map<RequestId, ThreadId>();
  const asked = new Map<RequestId, AskedRequest>();
  return {
    deciding,
    asked,
    forget: (threadId) => {
      for (const [id, of] of deciding) if (of === threadId) deciding.delete(id);
      for (const [id, request] of asked) if (request.threadId === threadId) asked.delete(id);
    },
  };
};

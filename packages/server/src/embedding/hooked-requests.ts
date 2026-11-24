import { isForcePush, outwardActions, type OpenSessionOptions } from "@gram/agents";
import type { ApprovalRequest, DecisionAction, RequestId, ThreadId } from "@gram/contracts";
import type { DecisionQuestion } from "./decision-hook.ts";

/** One thing a request does that the hook is asked about. */
export type RequestAction = Pick<DecisionQuestion, "action" | "detail">;

const SHELL_TOOL = /^(?:bash|shell|exec_command|local_shell|command)$/i;

const APP_TOOLS_SERVER = "gram";

/**
 * What the hook is asked about `request`: each outward thing its command line does, or the
 * connector call it is. Empty for anything else, which stays an ordinary card. A push that
 * rewrites or deletes what the remote holds carries `force: true`, so a force-push rule applies.
 */
export const requestActions = (
  request: Pick<ApprovalRequest, "toolName" | "input">,
): ReadonlyArray<RequestAction> => {
  if (request.toolName.startsWith("mcp__")) {
    const rest = request.toolName.slice("mcp__".length);
    const at = rest.indexOf("__");
    if (at <= 0) return [];
    const [server, tool] = [rest.slice(0, at), rest.slice(at + 2)];
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
  const force = actions.includes("push") && isForcePush(command);
  return actions.map((action) => ({
    action,
    detail: action === "push" && force ? { command, force: true } : { command },
  }));
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

/**
 * A request as the hook's bookkeeping knows it: its thread and its id together, since an agent's
 * request ids are its process's own, and two threads' agents can use the same one.
 */
export type HookedKey = string & { readonly HookedKey: unique symbol };

export const hookedKey = (threadId: ThreadId, requestId: RequestId): HookedKey =>
  `${threadId}\u0000${requestId}` as HookedKey;

/** A request put to the hook, as it was asked: its answer is for this request alone. */
export interface DecidingRequest {
  readonly threadId: ThreadId;
  readonly request: ApprovalRequest;
}

/** The requests the hook is deciding, and the ones it sent to a person, across all threads. */
export interface HookedRequests {
  /** Requests put to the hook and not yet answered or made a card. */
  readonly deciding: Map<HookedKey, DecidingRequest>;
  readonly asked: Map<HookedKey, AskedRequest>;
  /** A thread's requests were withdrawn (its turn stopped, its session went): forget them. */
  readonly forget: (threadId: ThreadId) => void;
}

export const makeHookedRequests = (): HookedRequests => {
  const deciding = new Map<HookedKey, DecidingRequest>();
  const asked = new Map<HookedKey, AskedRequest>();
  return {
    deciding,
    asked,
    forget: (threadId) => {
      for (const [id, of] of deciding) if (of.threadId === threadId) deciding.delete(id);
      for (const [id, request] of asked) if (request.threadId === threadId) asked.delete(id);
    },
  };
};

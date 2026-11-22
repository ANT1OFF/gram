import type {
  AgentEvent,
  AgentKind,
  ApprovalRequest,
  GramUIMessageChunk,
  MessageId,
  RequestId,
  TokenUsage,
} from "@gram/contracts";

import { type Json, record, text } from "./json.ts";
import { offeredOptions, scopeOf } from "./permissions.ts";

/** A call as Gram's cards draw it. */
export interface CardTool {
  readonly name: string;
  readonly input: Json;
}

/** What an agent's own updates can do to the turn under way. */
export interface TurnControls {
  /** Closes the step under way, as a finished model response does. */
  endStep(): void;
  /** The prompt the latest request sent, for the context meter. */
  setContextTokens(tokens: number): void;
  setContextWindow(window: number): void;
  /** The turn's usage, reported once it ends; `costUsd` adds to the session's price. */
  setTurnUsage(tokens: TokenUsage, costUsd?: number): void;
}

export interface AcpMapperOptions {
  readonly agent: AgentKind;
  readonly newMessageId: () => MessageId;
  /** The session this thread runs; updates for any other are ignored. */
  readonly sessionId: string;
  /** A `tool_call`'s or permission request's call as the card draws it. */
  readonly toolOf: (update: Json) => CardTool;
  /** What a finished call said. */
  readonly outputOf: (update: Json) => string;
  /** The error a turn the agent declined ends with. */
  readonly refusal: string;
  /** An update ACP doesn't define, or one the agent reads its own way. */
  readonly extension?: (update: Json, controls: TurnControls) => void;
  /** The usage the answer to `session/prompt` carries, when the agent reports it there. */
  readonly promptUsage?: (result: Json) => TokenUsage | undefined;
}

interface Turn {
  readonly messageId: MessageId;
  stepOpen: boolean;
  part: { readonly id: string; readonly kind: "text" | "reasoning" } | undefined;
  parts: number;
  readonly tools: Map<string, { name: string; done: boolean }>;
}

export interface AcpMapper {
  /** A `session/update`'s `update`. */
  update(update: Json): ReadonlyArray<AgentEvent>;
  /** A turn Gram started with `session/prompt`. */
  started(): ReadonlyArray<AgentEvent>;
  /**
   * `session/prompt` answered with `result`: the turn is over, for `stopReason`, or failed with
   * `error`.
   */
  ended(stopReason: string | undefined, error?: string, result?: Json): ReadonlyArray<AgentEvent>;
  /** A `session/request_permission`, shown as an approval card under `requestId`. */
  permission(requestId: RequestId, params: Json): ReadonlyArray<AgentEvent>;
  /** The card for `requestId` was answered, or its turn ended. */
  resolved(requestId: RequestId): ReadonlyArray<AgentEvent>;
  /** The session's prices summed so far, in US dollars. */
  readonly costUsd: () => number;
  /** The context window of the model the session runs on, for the usage meter. */
  setContextWindow(window: number | undefined): void;
}

const TOOL_FLAGS = { providerExecuted: true, dynamic: true } as const;

/**
 * An ACP agent's updates as Gram's events: one assistant message per turn, its thinking and text
 * as parts, its calls as the cards know them, permission requests as approval cards, and the
 * turn's usage and price.
 */
export const makeAcpMapper = (options: AcpMapperOptions): AcpMapper => {
  let turn: Turn | undefined;
  let costUsd = 0;
  let priced = false;
  let pendingUsage: TokenUsage | undefined;
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  const asked = new Set<RequestId>();

  const chunk = (t: Turn, c: GramUIMessageChunk): AgentEvent => ({
    type: "chunk",
    messageId: t.messageId,
    chunk: c,
  });

  const ensureTurn = (out: Array<AgentEvent>): Turn => {
    if (turn !== undefined) return turn;
    const t: Turn = {
      messageId: options.newMessageId(),
      stepOpen: false,
      part: undefined,
      parts: 0,
      tools: new Map(),
    };
    turn = t;
    out.push({ type: "status", status: "running" });
    out.push(
      chunk(t, {
        type: "start",
        messageId: t.messageId,
        messageMetadata: { agent: options.agent, agentSessionId: options.sessionId },
      }),
    );
    return t;
  };

  const startStep = (t: Turn, out: Array<AgentEvent>) => {
    if (t.stepOpen) return;
    t.stepOpen = true;
    out.push(chunk(t, { type: "start-step" }));
  };

  const endPart = (t: Turn, out: Array<AgentEvent>) => {
    const part = t.part;
    if (part === undefined) return;
    t.part = undefined;
    out.push(
      chunk(
        t,
        part.kind === "text"
          ? { type: "text-end", id: part.id }
          : { type: "reasoning-end", id: part.id },
      ),
    );
  };

  const endStep = (t: Turn, out: Array<AgentEvent>) => {
    if (!t.stepOpen) return;
    endPart(t, out);
    t.stepOpen = false;
    out.push(chunk(t, { type: "finish-step" }));
  };

  const append = (kind: "text" | "reasoning", delta: string, out: Array<AgentEvent>) => {
    if (delta === "") return;
    const t = ensureTurn(out);
    startStep(t, out);
    if (t.part?.kind !== kind) {
      endPart(t, out);
      const id = `${kind}-${++t.parts}`;
      t.part = { id, kind };
      out.push(
        chunk(t, kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id }),
      );
    }
    const id = t.part.id;
    out.push(
      chunk(
        t,
        kind === "text"
          ? { type: "text-delta", id, delta }
          : { type: "reasoning-delta", id, delta },
      ),
    );
  };

  const openTool = (update: Json, out: Array<AgentEvent>) => {
    const id = text(update["toolCallId"]);
    if (id === undefined) return;
    const t = ensureTurn(out);
    startStep(t, out);
    endPart(t, out);
    const tool = options.toolOf(update);
    if (!t.tools.has(id)) {
      t.tools.set(id, { name: tool.name, done: false });
      out.push(
        chunk(t, { type: "tool-input-start", toolCallId: id, toolName: tool.name, ...TOOL_FLAGS }),
      );
      out.push(
        chunk(t, {
          type: "tool-input-available",
          toolCallId: id,
          toolName: tool.name,
          input: tool.input,
          ...TOOL_FLAGS,
        }),
      );
    }
  };

  const finishTool = (update: Json, out: Array<AgentEvent>) => {
    const id = text(update["toolCallId"]);
    const status = text(update["status"]);
    const t = turn;
    if (id === undefined || t === undefined) return;
    if (!t.tools.has(id)) openTool(update, out);
    const tool = t.tools.get(id);
    if (tool === undefined || tool.done) return;
    if (status !== "completed" && status !== "failed") return;
    tool.done = true;
    const output = options.outputOf(update);
    out.push(
      chunk(
        t,
        status === "completed"
          ? { type: "tool-output-available", toolCallId: id, output, ...TOOL_FLAGS }
          : {
              type: "tool-output-error",
              toolCallId: id,
              errorText: output === "" ? "The tool failed" : output,
              ...TOOL_FLAGS,
            },
      ),
    );
  };

  const update = (input: Json): ReadonlyArray<AgentEvent> => {
    const out: Array<AgentEvent> = [];
    const t = turn;
    if (t === undefined) return out;
    switch (input["sessionUpdate"]) {
      case "agent_message_chunk":
        append("text", text(record(input["content"])["text"]) ?? "", out);
        break;
      case "agent_thought_chunk":
        append("reasoning", text(record(input["content"])["text"]) ?? "", out);
        break;
      case "tool_call":
        openTool(input, out);
        break;
      case "tool_call_update":
        finishTool(input, out);
        break;
      default:
        options.extension?.(input, {
          endStep: () => endStep(t, out),
          setContextTokens: (tokens) => {
            if (tokens > 0) contextTokens = tokens;
          },
          setContextWindow: (window) => {
            if (window > 0) contextWindow = window;
          },
          setTurnUsage: (tokens, price) => {
            if (price !== undefined) {
              costUsd += price;
              priced = true;
            }
            pendingUsage = tokens;
          },
        });
        break;
    }
    return out;
  };

  const ended = (
    stopReason: string | undefined,
    error?: string,
    result?: Json,
  ): ReadonlyArray<AgentEvent> => {
    const out: Array<AgentEvent> = [];
    const t = turn;
    const interrupted = stopReason === "cancelled";
    if (t !== undefined) {
      for (const [id, tool] of t.tools) {
        if (tool.done) continue;
        tool.done = true;
        out.push(
          chunk(t, {
            type: "tool-output-error",
            toolCallId: id,
            errorText: interrupted ? "Cancelled" : "The turn ended before the tool finished",
            ...TOOL_FLAGS,
          }),
        );
      }
      endStep(t, out);
      out.push(chunk(t, { type: "finish" }));
      turn = undefined;
    }
    const reported = result === undefined ? undefined : options.promptUsage?.(result);
    if (reported !== undefined) pendingUsage = reported;
    if (pendingUsage !== undefined)
      out.push({
        type: "usage",
        tokens: pendingUsage,
        ...(priced ? { costUsd } : {}),
        ...(contextTokens === undefined ? {} : { contextTokens }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
      });
    pendingUsage = undefined;
    for (const id of asked) out.push({ type: "requestResolved", requestId: id });
    asked.clear();
    if (error !== undefined) out.push({ type: "turnEnd", reason: "error", error });
    else if (interrupted) out.push({ type: "turnEnd", reason: "interrupted" });
    else if (stopReason === "max_turn_requests") out.push({ type: "turnEnd", reason: "maxTurns" });
    else if (stopReason === "refusal")
      out.push({ type: "turnEnd", reason: "error", error: options.refusal });
    else out.push({ type: "turnEnd", reason: "completed" });
    out.push({ type: "status", status: "idle" });
    return out;
  };

  const permission = (requestId: RequestId, params: Json): ReadonlyArray<AgentEvent> => {
    const out: Array<AgentEvent> = [];
    const call = record(params["toolCall"]);
    const scopes = [
      ...new Set(
        offeredOptions(params)
          .map(scopeOf)
          .filter((scope) => scope !== undefined),
      ),
    ];
    const toolUseId = text(call["toolCallId"]);
    if (toolUseId !== undefined && turn?.tools.has(toolUseId) !== true) openTool(call, out);
    const tool = options.toolOf(call);
    const title = text(call["title"]);
    const request: ApprovalRequest = {
      kind: "approval",
      id: requestId,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      toolName: tool.name,
      displayName: tool.name,
      input: tool.input,
      ...(title === undefined ? {} : { description: title }),
      suggestions: [],
      ...(scopes.length > 0 ? { scopes } : { scopes: ["once"] }),
    };
    asked.add(requestId);
    out.push({ type: "request", request });
    out.push({ type: "status", status: "awaitingApproval" });
    return out;
  };

  return {
    update,
    started: () => {
      const out: Array<AgentEvent> = [];
      ensureTurn(out);
      return out;
    },
    ended,
    permission,
    resolved: (requestId) => {
      if (!asked.delete(requestId)) return [];
      return [
        { type: "requestResolved", requestId },
        ...(turn === undefined ? [] : [{ type: "status", status: "running" } as const]),
      ];
    },
    costUsd: () => costUsd,
    setContextWindow: (window) => {
      contextWindow = window;
    },
  };
};

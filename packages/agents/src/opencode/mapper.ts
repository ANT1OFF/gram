import {
  type AgentEvent,
  type ApprovalRequest,
  type GramUIMessageChunk,
  type MessageId,
  RequestId,
  type TokenUsage,
} from "@gram/contracts";

import {
  contentText,
  errorOf,
  field,
  permissionOf,
  tokensOf,
  type OpenCodeEvent,
  type OpenCodePermission,
} from "./protocol.ts";

/**
 * OpenCode's tools as Gram's cards know them: Claude Code's names and input keys, so a shell
 * command, an edit or a read draws the same card whichever agent made it. A tool it doesn't name
 * (an MCP server's, `execute`) keeps OpenCode's own name and input.
 */
export const toolFor = (
  name: string,
  input: Readonly<Record<string, unknown>>,
): { readonly name: string; readonly input: Readonly<Record<string, unknown>> } => {
  const pick = (entries: ReadonlyArray<readonly [string, string]>) =>
    Object.fromEntries(
      entries.flatMap(([from, to]) => (input[from] === undefined ? [] : [[to, input[from]]])),
    );
  switch (name) {
    case "shell":
      return {
        name: "Bash",
        input: pick([
          ["command", "command"],
          ["description", "description"],
          ["workdir", "cwd"],
          ["timeout", "timeout"],
        ]),
      };
    case "read":
      return {
        name: "Read",
        input: pick([
          ["path", "file_path"],
          ["offset", "offset"],
          ["limit", "limit"],
        ]),
      };
    case "write":
      return {
        name: "Write",
        input: pick([
          ["path", "file_path"],
          ["content", "content"],
        ]),
      };
    case "edit":
      return {
        name: "Edit",
        input: pick([
          ["path", "file_path"],
          ["oldString", "old_string"],
          ["newString", "new_string"],
          ["replaceAll", "replace_all"],
        ]),
      };
    case "glob":
      return {
        name: "Glob",
        input: pick([
          ["pattern", "pattern"],
          ["path", "path"],
        ]),
      };
    case "grep":
      return {
        name: "Grep",
        input: pick([
          ["pattern", "pattern"],
          ["path", "path"],
          ["include", "glob"],
        ]),
      };
    case "webfetch":
      return { name: "WebFetch", input: pick([["url", "url"]]) };
    case "websearch":
      return { name: "WebSearch", input: pick([["query", "query"]]) };
    case "subagent":
      return {
        name: "Task",
        input: pick([
          ["agent", "subagent_type"],
          ["description", "description"],
          ["prompt", "prompt"],
          ["model", "model"],
        ]),
      };
    case "skill":
      return { name: "Skill", input: pick([["id", "skill"]]) };
    default:
      return { name, input };
  }
};

const ACTION_TOOLS: Readonly<Record<string, string>> = {
  shell: "Bash",
  edit: "Edit",
  read: "Read",
  write: "Write",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  subagent: "Task",
  skill: "Skill",
};

const actionInput = (permission: OpenCodePermission): Readonly<Record<string, unknown>> => {
  const subject = permission.resources.join(" ");
  switch (permission.action) {
    case "shell":
      return { command: subject };
    case "webfetch":
      return { url: subject };
    case "websearch":
      return { query: subject };
    case "edit":
    case "read":
    case "write":
    case "external_directory":
      return { file_path: subject };
    default:
      return { resources: permission.resources };
  }
};

const TOOL_FLAGS = { providerExecuted: true, dynamic: true } as const;

export const tokenUsage = (tokens: {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}): TokenUsage => ({
  inputTokens: tokens.input,
  outputTokens: tokens.output,
  ...(tokens.cache.read > 0 ? { cacheReadTokens: tokens.cache.read } : {}),
  ...(tokens.cache.write > 0 ? { cacheWriteTokens: tokens.cache.write } : {}),
  ...(tokens.reasoning > 0 ? { reasoningTokens: tokens.reasoning } : {}),
});

export interface OpenCodeMapperOptions {
  readonly newMessageId: () => MessageId;
  /** The OpenCode session this thread runs; events of any other are ignored. */
  readonly sessionId: string;
}

interface Turn {
  readonly messageId: MessageId;
  readonly steps: Array<string>;
  stepOpen: boolean;
  readonly open: Map<string, "text" | "reasoning">;
  readonly tools: Map<string, { name: string; done: boolean }>;
}

export interface OpenCodeMapper {
  map(event: OpenCodeEvent): ReadonlyArray<AgentEvent>;
  /** The turn the user stopped, closed as interrupted. */
  interrupted(): ReadonlyArray<AgentEvent>;
}

const partId = (data: Readonly<Record<string, unknown>>, kind: "text" | "reasoning") =>
  `${field.string(data, "assistantMessageID") ?? "step"}:${kind}:${field.number(data, "ordinal") ?? 0}`;

/**
 * OpenCode's session events as Gram's: one assistant message per execution (OpenCode's word for a
 * turn), a step per model call, Claude Code's tool names, approvals as requests, and usage.
 */
export const makeOpenCodeMapper = (options: OpenCodeMapperOptions): OpenCodeMapper => {
  let turn: Turn | undefined;
  const asked = new Set<string>();
  const calls = new Map<string, { name: string; input: Readonly<Record<string, unknown>> }>();
  let costUsd = 0;
  let tokens: TokenUsage | undefined;

  const chunk = (t: Turn, c: GramUIMessageChunk): AgentEvent => ({
    type: "chunk",
    messageId: t.messageId,
    chunk: c,
  });

  const ensureTurn = (out: Array<AgentEvent>): Turn => {
    if (turn !== undefined) return turn;
    const t: Turn = {
      messageId: options.newMessageId(),
      steps: [],
      stepOpen: false,
      open: new Map(),
      tools: new Map(),
    };
    turn = t;
    out.push(
      chunk(t, {
        type: "start",
        messageId: t.messageId,
        messageMetadata: { agent: "opencode", agentSessionId: options.sessionId },
      }),
    );
    return t;
  };

  const startStep = (t: Turn, assistantMessageId: string | undefined, out: Array<AgentEvent>) => {
    if (t.stepOpen) return;
    t.stepOpen = true;
    if (assistantMessageId !== undefined && !t.steps.includes(assistantMessageId))
      t.steps.push(assistantMessageId);
    out.push(chunk(t, { type: "start-step" }));
  };

  const endParts = (t: Turn, out: Array<AgentEvent>) => {
    for (const [id, kind] of t.open)
      out.push(
        chunk(t, kind === "text" ? { type: "text-end", id } : { type: "reasoning-end", id }),
      );
    t.open.clear();
  };

  const endStep = (t: Turn, out: Array<AgentEvent>) => {
    if (!t.stepOpen) return;
    endParts(t, out);
    t.stepOpen = false;
    out.push(chunk(t, { type: "finish-step" }));
  };

  const endTurn = (
    out: Array<AgentEvent>,
    reason: "completed" | "interrupted" | "error",
    error?: string,
  ) => {
    const t = turn;
    if (t !== undefined) {
      for (const [id, tool] of t.tools) {
        if (tool.done) continue;
        out.push(
          chunk(t, {
            type: "tool-output-error",
            toolCallId: id,
            errorText:
              reason === "interrupted" ? "Cancelled" : "The turn ended before the tool finished",
            ...TOOL_FLAGS,
          }),
        );
      }
      endStep(t, out);
      for (const id of t.tools.keys()) {
        calls.delete(id);
        rawNames.delete(id);
      }
      if (t.steps.length > 0)
        out.push(
          chunk(t, { type: "message-metadata", messageMetadata: { agentMessageIds: t.steps } }),
        );
      out.push(chunk(t, { type: "finish" }));
      turn = undefined;
    }
    if (tokens !== undefined) out.push({ type: "usage", tokens, costUsd });
    tokens = undefined;
    for (const id of asked) out.push({ type: "requestResolved", requestId: RequestId.make(id) });
    asked.clear();
    out.push({ type: "turnEnd", reason, ...(error === undefined ? {} : { error }) });
    out.push({ type: "status", status: "idle" });
  };

  const approval = (permission: OpenCodePermission): ApprovalRequest => {
    const call = permission.source === undefined ? undefined : calls.get(permission.source.id);
    const toolName = call?.name ?? ACTION_TOOLS[permission.action] ?? permission.action;
    return {
      kind: "approval",
      id: RequestId.make(permission.id),
      ...(permission.source === undefined ? {} : { toolUseId: permission.source.id }),
      toolName,
      displayName: toolName,
      input: call?.input ?? actionInput(permission),
      ...(permission.message === undefined ? {} : { description: permission.message }),
      suggestions: [],
      scopes: ["once", "always"],
    };
  };

  const map = (event: OpenCodeEvent): ReadonlyArray<AgentEvent> => {
    const { data } = event;
    const session = field.string(data, "sessionID");
    if (session !== undefined && session !== options.sessionId) return [];
    const out: Array<AgentEvent> = [];
    switch (event.type) {
      case "session.execution.started":
        out.push({ type: "status", status: "running" });
        ensureTurn(out);
        break;
      case "session.step.started": {
        const t = ensureTurn(out);
        startStep(t, field.string(data, "assistantMessageID"), out);
        break;
      }
      case "session.text.started":
      case "session.reasoning.started": {
        const kind = event.type === "session.text.started" ? "text" : "reasoning";
        const t = ensureTurn(out);
        startStep(t, field.string(data, "assistantMessageID"), out);
        const id = partId(data, kind);
        if (!t.open.has(id)) {
          t.open.set(id, kind);
          out.push(
            chunk(
              t,
              kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id },
            ),
          );
        }
        break;
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        const kind = event.type === "session.text.delta" ? "text" : "reasoning";
        const delta = field.string(data, "delta") ?? "";
        const t = ensureTurn(out);
        startStep(t, field.string(data, "assistantMessageID"), out);
        const id = partId(data, kind);
        if (!t.open.has(id)) {
          t.open.set(id, kind);
          out.push(
            chunk(
              t,
              kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id },
            ),
          );
        }
        if (delta !== "")
          out.push(
            chunk(
              t,
              kind === "text"
                ? { type: "text-delta", id, delta }
                : { type: "reasoning-delta", id, delta },
            ),
          );
        break;
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = event.type === "session.text.ended" ? "text" : "reasoning";
        const t = turn;
        const id = partId(data, kind);
        if (t === undefined || !t.open.has(id)) break;
        t.open.delete(id);
        out.push(
          chunk(t, kind === "text" ? { type: "text-end", id } : { type: "reasoning-end", id }),
        );
        break;
      }
      case "session.tool.input.started": {
        const id = field.string(data, "id");
        const name = field.string(data, "name");
        if (id === undefined || name === undefined) break;
        const t = ensureTurn(out);
        startStep(t, field.string(data, "assistantMessageID"), out);
        const toolName = toolFor(name, {}).name;
        t.tools.set(id, { name: toolName, done: false });
        calls.set(id, { name: toolName, input: {} });
        rawNames.set(id, name);
        out.push(chunk(t, { type: "tool-input-start", toolCallId: id, toolName, ...TOOL_FLAGS }));
        break;
      }
      case "session.tool.called": {
        const id = field.string(data, "id");
        if (id === undefined) break;
        const t = ensureTurn(out);
        const raw = rawNames.get(id) ?? field.string(data, "name") ?? "tool";
        const tool = toolFor(raw, field.record(data, "input") ?? {});
        if (!t.tools.has(id)) {
          t.tools.set(id, { name: tool.name, done: false });
          out.push(
            chunk(t, {
              type: "tool-input-start",
              toolCallId: id,
              toolName: tool.name,
              ...TOOL_FLAGS,
            }),
          );
        }
        calls.set(id, tool);
        out.push(
          chunk(t, {
            type: "tool-input-available",
            toolCallId: id,
            toolName: tool.name,
            input: tool.input,
            ...TOOL_FLAGS,
          }),
        );
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const id = field.string(data, "id");
        const t = turn;
        const tool = id === undefined ? undefined : t?.tools.get(id);
        if (t === undefined || id === undefined || tool === undefined || tool.done) break;
        tool.done = true;
        const text = contentText(data["content"]);
        if (event.type === "session.tool.success") {
          out.push(
            chunk(t, {
              type: "tool-output-available",
              toolCallId: id,
              output: text,
              ...TOOL_FLAGS,
            }),
          );
        } else {
          const error = errorOf(data["error"]);
          out.push(
            chunk(t, {
              type: "tool-output-error",
              toolCallId: id,
              errorText: [error?.message, text].filter(Boolean).join("\n") || "The tool failed",
              ...TOOL_FLAGS,
            }),
          );
        }
        break;
      }
      case "session.step.ended":
      case "session.step.failed": {
        const t = turn;
        if (t !== undefined) endStep(t, out);
        if (event.type === "session.step.failed") {
          const error = errorOf(data["error"]);
          if (error !== undefined)
            out.push({ type: "notice", level: "error", message: error.message });
        }
        break;
      }
      case "session.usage.updated": {
        const usage = tokensOf(data["tokens"]);
        if (usage !== undefined) tokens = tokenUsage(usage);
        costUsd = field.number(data, "cost") ?? costUsd;
        break;
      }
      case "session.retry.scheduled": {
        const error = errorOf(data["error"]);
        out.push({
          type: "status",
          status: "retrying",
          ...(error === undefined ? {} : { detail: error.message }),
        });
        break;
      }
      case "session.compaction.started":
        out.push({ type: "status", status: "compacting" });
        break;
      case "session.compaction.ended":
      case "session.compaction.failed":
        out.push({ type: "status", status: turn === undefined ? "idle" : "running" });
        break;
      case "permission.asked": {
        const permission = permissionOf(data);
        if (permission === undefined || asked.has(permission.id)) break;
        asked.add(permission.id);
        out.push({ type: "request", request: approval(permission) });
        out.push({ type: "status", status: "awaitingApproval" });
        break;
      }
      case "permission.replied": {
        const id = field.string(data, "requestID");
        if (id === undefined || !asked.delete(id)) break;
        out.push({ type: "requestResolved", requestId: RequestId.make(id) });
        if (turn !== undefined) out.push({ type: "status", status: "running" });
        break;
      }
      case "session.model.selected": {
        const model = field.record(data, "model");
        const id = model === undefined ? undefined : field.string(model, "id");
        const provider = model === undefined ? undefined : field.string(model, "providerID");
        if (id !== undefined && provider !== undefined)
          out.push({ type: "model", model: `${provider}/${id}` });
        break;
      }
      case "session.execution.succeeded":
        endTurn(out, "completed");
        break;
      case "session.execution.failed": {
        const error = errorOf(data["error"]);
        endTurn(out, "error", error?.message ?? "OpenCode stopped with an error");
        break;
      }
      case "session.execution.interrupted":
        endTurn(out, "interrupted");
        break;
      default:
        break;
    }
    return out;
  };

  const rawNames = new Map<string, string>();

  return {
    map,
    interrupted: () => {
      const out: Array<AgentEvent> = [];
      if (turn !== undefined) endTurn(out, "interrupted");
      return out;
    },
  };
};

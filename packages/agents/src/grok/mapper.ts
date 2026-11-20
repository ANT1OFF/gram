import type {
  AgentEvent,
  ApprovalRequest,
  ApprovalScope,
  GramUIMessageChunk,
  MessageId,
  RequestId,
  TokenUsage,
} from "@gram/contracts";

type Json = Readonly<Record<string, unknown>>;

const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** Grok Build's own name for a call: its `x.ai/tool` meta, else the ACP title it opened with. */
export const grokToolName = (update: Json): string =>
  text(record(record(update["_meta"])["x.ai/tool"])["name"]) ?? text(update["title"]) ?? "tool";

/**
 * Grok Build's tools as Gram's cards know them: Claude Code's names and input keys, so a command,
 * an edit or a read draws the same card whichever agent made it. A tool it doesn't name (an MCP
 * server's) keeps Grok's own name and input.
 */
export const toolFor = (
  name: string,
  input: Json,
): { readonly name: string; readonly input: Json } => {
  const pick = (entries: ReadonlyArray<readonly [string, string]>) =>
    Object.fromEntries(
      entries.flatMap(([from, to]) => (input[from] === undefined ? [] : [[to, input[from]]])),
    );
  switch (name) {
    case "run_terminal_command":
      return {
        name: "Bash",
        input: pick([
          ["command", "command"],
          ["description", "description"],
          ["is_background", "run_in_background"],
        ]),
      };
    case "read_file":
      return {
        name: "Read",
        input: pick([
          ["target_file", "file_path"],
          ["offset", "offset"],
          ["limit", "limit"],
        ]),
      };
    case "search_replace":
    case "edit":
      return {
        name: "Edit",
        input: pick([
          ["file_path", "file_path"],
          ["old_string", "old_string"],
          ["new_string", "new_string"],
          ["replace_all", "replace_all"],
        ]),
      };
    case "write":
      return {
        name: "Write",
        input: pick([
          ["file_path", "file_path"],
          ["target_file", "file_path"],
          ["content", "content"],
        ]),
      };
    case "grep":
      return {
        name: "Grep",
        input: pick([
          ["pattern", "pattern"],
          ["path", "path"],
          ["glob", "glob"],
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
    case "list_dir":
      return { name: "LS", input: pick([["target_directory", "path"]]) };
    case "web_search":
      return { name: "WebSearch", input: pick([["query", "query"]]) };
    case "web_fetch":
      return { name: "WebFetch", input: pick([["url", "url"]]) };
    case "spawn_subagent":
    case "task":
      return {
        name: "Task",
        input: pick([
          ["description", "description"],
          ["prompt", "prompt"],
          ["agent", "subagent_type"],
        ]),
      };
    case "todo_write":
      return { name: "TodoWrite", input: pick([["todos", "todos"]]) };
    default:
      return { name, input };
  }
};

/** The longest output kept from a call that gave no text content. */
const OUTPUT_MAX = 20_000;

/** What a finished call said: its text content, else the text its raw output carries. */
export const outputText = (update: Json): string => {
  const parts: Array<string> = [];
  const content = update["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      const entry = record(item);
      if (entry["type"] === "content") {
        const body = text(record(entry["content"])["text"]);
        if (body !== undefined && body !== "") parts.push(body);
      } else if (entry["type"] === "diff") {
        const path = text(entry["path"]);
        if (path !== undefined) parts.push(`Updated ${path}`);
      }
    }
  }
  if (parts.length > 0) return parts.join("\n");
  const raw = record(update["rawOutput"]);
  const found = [
    text(raw["output_for_prompt"]),
    text(record(raw["Content"])["content"]),
    text(record(raw["EditsApplied"])["tool_output_for_prompt"]),
  ].find((each) => each !== undefined && each !== "");
  if (found !== undefined) return found.slice(0, OUTPUT_MAX);
  return "";
};

/** A turn's usage as Grok Build reports it in `turn_completed`. */
export const turnUsage = (usage: Json): TokenUsage => {
  const cached = count(usage["cachedReadTokens"]);
  const written = count(usage["cacheCreationTokens"]);
  const reasoning = count(usage["reasoningTokens"]);
  return {
    inputTokens: Math.max(0, count(usage["inputTokens"]) - cached),
    outputTokens: count(usage["outputTokens"]),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    ...(written > 0 ? { cacheWriteTokens: written } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
};

/** Grok Build prices a turn in ticks: ten billion to the US dollar. */
export const USD_TICKS = 1e10;

/** The ACP option to pick for an answer, from the ones the request offered. */
export interface PermissionOption {
  readonly optionId: string;
  readonly kind: string;
}

/** Gram's scope for an option: `allow_always` is session-long when its id says so. */
export const scopeOf = (option: PermissionOption): ApprovalScope | undefined => {
  if (option.kind === "allow_once") return "once";
  if (option.kind === "allow_always") return option.optionId.endsWith("-session") ? "session" : "always";
  return undefined;
};

/** The option that carries `decision` at `scope`, falling back to the narrowest allow. */
export const optionFor = (
  options: ReadonlyArray<PermissionOption>,
  decision: "allow" | "deny",
  scope: ApprovalScope | undefined,
): PermissionOption | undefined => {
  if (decision === "deny")
    return options.find((option) => option.kind === "reject_once") ??
      options.find((option) => option.kind.startsWith("reject"));
  return (
    options.find((option) => scope !== undefined && scopeOf(option) === scope) ??
    options.find((option) => option.kind === "allow_once")
  );
};

const TOOL_FLAGS = { providerExecuted: true, dynamic: true } as const;

export interface GrokMapperOptions {
  readonly newMessageId: () => MessageId;
  /** The Grok Build session this thread runs; updates for any other are ignored. */
  readonly sessionId: string;
}

interface Turn {
  readonly messageId: MessageId;
  stepOpen: boolean;
  part: { readonly id: string; readonly kind: "text" | "reasoning" } | undefined;
  parts: number;
  readonly tools: Map<string, { name: string; done: boolean }>;
}

export interface GrokMapper {
  /** A `session/update` or `_x.ai/session_notification`'s `update`. */
  update(update: Json): ReadonlyArray<AgentEvent>;
  /** A turn Gram started with `session/prompt`. */
  started(): ReadonlyArray<AgentEvent>;
  /** `session/prompt` answered: the turn is over, for `stopReason`, or failed with `error`. */
  ended(stopReason: string | undefined, error?: string): ReadonlyArray<AgentEvent>;
  /** A `session/request_permission`, shown as an approval card under `requestId`. */
  permission(requestId: RequestId, params: Json): ReadonlyArray<AgentEvent>;
  /** The card for `requestId` was answered, or its turn ended. */
  resolved(requestId: RequestId): ReadonlyArray<AgentEvent>;
  /** The session's prices summed so far, in US dollars. */
  readonly costUsd: () => number;
  /** The context window of the model the session runs on, for the usage meter. */
  setContextWindow(window: number | undefined): void;
}

/**
 * Grok Build's ACP updates as Gram's events: one assistant message per turn, its thinking and text
 * as parts, its calls under Claude Code's tool names, permission requests as approval cards, and
 * the turn's usage and price.
 */
export const makeGrokMapper = (options: GrokMapperOptions): GrokMapper => {
  let turn: Turn | undefined;
  let costUsd = 0;
  let pendingUsage: { tokens: TokenUsage; costUsd: number } | undefined;
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
        messageMetadata: { agent: "grok", agentSessionId: options.sessionId },
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
        part.kind === "text" ? { type: "text-end", id: part.id } : { type: "reasoning-end", id: part.id },
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
      out.push(chunk(t, kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id }));
    }
    const id = t.part.id;
    out.push(
      chunk(t, kind === "text" ? { type: "text-delta", id, delta } : { type: "reasoning-delta", id, delta }),
    );
  };

  const openTool = (update: Json, out: Array<AgentEvent>) => {
    const id = text(update["toolCallId"]);
    if (id === undefined) return;
    const t = ensureTurn(out);
    startStep(t, out);
    endPart(t, out);
    const tool = toolFor(grokToolName(update), record(update["rawInput"]));
    if (!t.tools.has(id)) {
      t.tools.set(id, { name: tool.name, done: false });
      out.push(chunk(t, { type: "tool-input-start", toolCallId: id, toolName: tool.name, ...TOOL_FLAGS }));
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
    const output = outputText(update);
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
      case "response_completed": {
        const usage = record(input["usage"]);
        const prompt = count(usage["input_tokens"]) + count(usage["cache_read_input_tokens"]);
        if (prompt > 0) contextTokens = prompt;
        if (turn !== undefined) endStep(turn, out);
        break;
      }
      case "turn_completed": {
        const usage = record(input["usage"]);
        const ticks = usage["costUsdTicks"];
        if (typeof ticks === "number" && Number.isFinite(ticks) && ticks >= 0)
          costUsd += ticks / USD_TICKS;
        pendingUsage = { tokens: turnUsage(usage), costUsd };
        break;
      }
      case "current_mode_update":
        break;
      default:
        break;
    }
    return out;
  };

  const ended = (stopReason: string | undefined, error?: string): ReadonlyArray<AgentEvent> => {
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
    if (pendingUsage !== undefined)
      out.push({
        type: "usage",
        tokens: pendingUsage.tokens,
        costUsd: pendingUsage.costUsd,
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
      out.push({ type: "turnEnd", reason: "error", error: "Grok declined to continue." });
    else out.push({ type: "turnEnd", reason: "completed" });
    out.push({ type: "status", status: "idle" });
    return out;
  };

  const permission = (requestId: RequestId, params: Json): ReadonlyArray<AgentEvent> => {
    const out: Array<AgentEvent> = [];
    const call = record(params["toolCall"]);
    const offered = (Array.isArray(params["options"]) ? params["options"] : [])
      .map(record)
      .flatMap((option): Array<PermissionOption> => {
        const optionId = text(option["optionId"]);
        const kind = text(option["kind"]);
        return optionId === undefined || kind === undefined ? [] : [{ optionId, kind }];
      });
    const scopes = [...new Set(offered.map(scopeOf).filter((scope) => scope !== undefined))];
    const toolUseId = text(call["toolCallId"]);
    if (toolUseId !== undefined && turn?.tools.has(toolUseId) !== true) openTool(call, out);
    const tool = toolFor(grokToolName(call), record(call["rawInput"]));
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

import type {
  SDKControlInitializeResponse,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type {
  AgentEvent,
  AgentFailure,
  AgentStatus,
  BackgroundTask,
  BackgroundTaskKind,
  CompactionActivity,
  MessageId,
  PermissionMode,
  PlanItem,
  SlashCommand,
  SubagentUsage,
  GramUIMessageChunk,
  TurnEndReason,
} from "@gram/contracts";
import { claudeFailure } from "../failure.ts";
import { offered, toSlashCommand, type ReportedCommand } from "./commands.ts";
import { makeUsageLedger } from "./usage.ts";

export interface MapperOptions {
  readonly newMessageId: () => MessageId;
  /**
   * USD per input-token equivalent by model id, as sessions learn it from their results. Shared
   * between sessions so a new one can guess at its first turn; its own map when left out.
   */
  readonly rates?: Map<string, number>;
  /** The clock a subagent's `startedAt` and a compaction's `at` are read from; `Date.now` when left out. */
  readonly now?: () => number;
  /**
   * The `total_cost_usd` a resumed session starts from, restored from its transcript. Reported costs
   * count from zero, so this much is taken off; 0 when left out.
   */
  readonly carriedCost?: number;
}

/** What an `auth_status` error tells the user to do: their `claude` keeps its own login. */
export const DEFAULT_SIGN_IN_HINT = "Run `claude /login`.";

export interface ClaudeMapper {
  map(message: SDKMessage): Array<AgentEvent>;
  /** The commands `initializationResult()` lists; `system/init` only carries names. */
  setCommands(commands: ReadonlyArray<ReportedCommand>): void;
  /**
   * What the SDK's model list says the picked model costs per input token, for estimating before
   * the session has a result; `undefined` when it names no price.
   */
  setAdvertisedRate(rate: number | undefined): void;
  /**
   * The session switched model: the resolved id when known, else what was asked for. `system/init`
   * only reports the model the session opened with.
   */
  setSessionModel(model: string): void;
  /**
   * The main agent's `PostCompact` hook ran: `compact_summary` is the only place the SDK hands over
   * what it now carries on from. It runs before its `compact_boundary`, which takes the summary along.
   */
  compacted(summary: string): Array<AgentEvent>;
  /**
   * The main agent's `PreCompact` hook ran: the first word of who started the compaction its
   * `compacting` status announced a moment before.
   */
  compacting(trigger: "manual" | "auto"): Array<AgentEvent>;
  /**
   * The shell commands still running whose output the CLI can read back, by the task id
   * `getTaskOutput` takes: foreground ones once the CLI registers them as a task, and background
   * ones (`run_in_background`, or moved there on timeout) until their task ends.
   */
  runningShells(): ReadonlyArray<RunningShell>;
  /**
   * A `getTaskOutput` read of a running shell, if it has something new: a preliminary snapshot of
   * a foreground Bash call's output while the call runs, or a background shell's
   * `backgroundOutput`. Never an empty one.
   */
  shellOutput(taskId: string, read: TaskOutputRead): Array<AgentEvent>;
  /** Finishes any open messages, e.g. when the query ends mid-turn. */
  flush(): Array<AgentEvent>;
  /** The user sent input, so the next reply answers it rather than a background report. */
  sent(): void;
  /** A late steering reply starts an agent-initiated continuation. */
  continued(): void;
}

type Chunk = GramUIMessageChunk;

interface RunningShell {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly background?: boolean;
}

/**
 * What `getTaskOutput` answers: SDK 0.3.296's `SDKControlGetTaskOutputResponse` (`sdk.d.ts`), the
 * last 8 KiB the command wrote, stdout and stderr together.
 */
export interface TaskOutputRead {
  readonly output: string;
  readonly total_bytes: number;
  readonly truncated: boolean;
}

const readText = (read: TaskOutputRead): string => {
  const cut = read.truncated ? read.output.indexOf("\n") : -1;
  const trimmed = cut === -1 ? read.output : read.output.slice(cut + 1);
  return trimmed === "" ? read.output : trimmed;
};

const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

type OpenBlock =
  | { readonly kind: "text" | "reasoning"; readonly id: string }
  | { readonly kind: "tool"; readonly toolCallId: string };

interface Lane {
  readonly messageId: MessageId;
  step: string | undefined;
  model: string | undefined;
  modelConflict: boolean;
  readonly streamed: Set<string>;
  readonly blocks: Map<number, OpenBlock>;
  seq: number;
  readonly agentMessageIds: Array<string>;
}

interface ToolCall {
  readonly toolName: string;
  readonly dynamic: boolean;
  readonly lane: string;
}

const MAIN = "";
const SYNTHETIC_MODEL = "<synthetic>";

const chunk = (lane: Lane, c: Chunk): AgentEvent => ({
  type: "chunk",
  messageId: lane.messageId,
  chunk: c,
});

const notice = (level: "info" | "warning" | "error", message: string): AgentEvent => ({
  type: "notice",
  level,
  message,
});

const isDynamicTool = (name: string): boolean => name.startsWith("mcp__");

const toolFlags = (dynamic: boolean) =>
  dynamic ? { providerExecuted: true, dynamic: true } : { providerExecuted: true };

const asRecord = (u: unknown): Record<string, unknown> =>
  typeof u === "object" && u !== null ? (u as Record<string, unknown>) : {};

const summaryText = (raw: string): string | undefined => {
  const open = raw.indexOf("<summary>");
  let text: string;
  if (open !== -1) {
    const from = open + "<summary>".length;
    const close = raw.indexOf("</summary>", from);
    text = raw.slice(from, close === -1 ? undefined : close);
  } else {
    text = "";
    let at = 0;
    for (;;) {
      const start = raw.indexOf("<analysis>", at);
      if (start === -1) break;
      text += raw.slice(at, start);
      const end = raw.indexOf("</analysis>", start);
      if (end === -1) {
        at = raw.length;
        break;
      }
      at = end + "</analysis>".length;
    }
    text += raw.slice(at);
  }
  text = text.trim();
  return text === "" ? undefined : text;
};

const int = (u: unknown): number | undefined =>
  typeof u === "number" && Number.isFinite(u) ? Math.trunc(u) : undefined;

const resultText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = asRecord(block);
      return b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "";
    })
    .filter((text) => text !== "")
    .join("\n");
};

interface ResultImage {
  readonly mediaType: string;
  readonly data: string;
}

const resultImages = (content: unknown): Array<ResultImage> => {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const source = asRecord(asRecord(block)["source"]);
    const { media_type: mediaType, data } = source;
    return asRecord(block)["type"] === "image" &&
      source["type"] === "base64" &&
      typeof mediaType === "string" &&
      typeof data === "string"
      ? [{ mediaType, data }]
      : [];
  });
};

const withoutImageBytes = (output: unknown): unknown => {
  if (Array.isArray(output)) {
    return output.map((block: unknown) => {
      const b = asRecord(block);
      if (b["type"] !== "image" || typeof asRecord(b["source"])["data"] !== "string") return block;
      const { data: _, ...source } = asRecord(b["source"]);
      return { ...b, source };
    });
  }
  const o = asRecord(output);
  if (o["type"] !== "image" || typeof asRecord(o["file"])["base64"] !== "string") return output;
  const { base64: _, ...file } = asRecord(o["file"]);
  return { ...o, file };
};

interface TaskUsageFields {
  readonly usage?: {
    readonly total_tokens: number;
    readonly tool_uses: number;
    readonly duration_ms: number;
  };
  readonly subagent_type?: string;
  readonly last_tool_name?: string;
  readonly summary?: string;
  readonly startedAt?: number | undefined;
}

const subagentUsage = (
  toolCallId: string,
  status: SubagentUsage["status"],
  m: TaskUsageFields,
): AgentEvent => {
  const totalTokens = int(m.usage?.total_tokens);
  const toolUses = int(m.usage?.tool_uses);
  const durationMs = int(m.usage?.duration_ms);
  return {
    type: "subagentUsage",
    usage: {
      toolCallId,
      status,
      ...(totalTokens === undefined ? {} : { totalTokens }),
      ...(toolUses === undefined ? {} : { toolUses }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(m.startedAt === undefined ? {} : { startedAt: m.startedAt }),
      ...(m.subagent_type === undefined ? {} : { subagentType: m.subagent_type }),
      ...(m.last_tool_name === undefined ? {} : { lastToolName: m.last_tool_name }),
      ...(m.summary ? { summary: m.summary } : {}),
    },
  };
};

const TODO_STATUS: Readonly<Record<string, PlanItem["status"]>> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

const todoPlan = (input: unknown): Array<PlanItem> | undefined => {
  const todos = asRecord(input)["todos"];
  if (!Array.isArray(todos)) return undefined;
  return todos.flatMap((todo): Array<PlanItem> => {
    const { content, status, activeForm } = asRecord(todo);
    if (typeof content !== "string" || content === "") return [];
    return [
      {
        content,
        status: (typeof status === "string" ? TODO_STATUS[status] : undefined) ?? "pending",
        ...(typeof activeForm === "string" && activeForm !== "" ? { activeForm } : {}),
      },
    ];
  });
};

const TASK_KINDS: Readonly<Record<string, BackgroundTaskKind>> = {
  local_agent: "subagent",
  local_bash: "shell",
  local_workflow: "workflow",
  mcp_task: "mcp",
};

interface TaskStart {
  readonly startedAt: number;
  readonly toolCallId?: string | undefined;
  readonly subagentType?: string | undefined;
  readonly command?: string | undefined;
  readonly shell?: boolean;
}

const turnEnd = (
  result: SDKResultMessage,
  apiError?: string,
  apiErrorText?: string,
): {
  readonly reason: TurnEndReason;
  readonly error?: string;
  readonly failure?: AgentFailure;
} => {
  const terminal = asRecord(result)["terminal_reason"];
  if (
    (terminal === "aborted_tools" || terminal === "aborted_streaming") &&
    apiError !== undefined &&
    apiErrorText !== undefined
  ) {
    return {
      reason: "error",
      error: apiErrorText,
      failure: claudeFailure(int(asRecord(result)["api_error_status"]), apiError, apiErrorText),
    };
  }
  if (terminal === "aborted_tools" || terminal === "aborted_streaming") {
    return { reason: "interrupted" };
  }
  if (result.subtype === "error_max_turns" || terminal === "max_turns")
    return { reason: "maxTurns" };
  const status = int(asRecord(result)["api_error_status"]);
  const failed = (error: string) =>
    status === undefined && apiError === undefined
      ? { reason: "error" as const, error }
      : { reason: "error" as const, error, failure: claudeFailure(status, apiError, error) };
  if (result.subtype !== "success") return failed(result.errors.join("\n") || result.subtype);
  return result.is_error ? failed(result.result) : { reason: "completed" };
};

/** The `identity` event available at warm-up, before any `system/init`. */
export const identityFromInitialization = (
  init: SDKControlInitializeResponse,
  session: { readonly agentSessionId: string; readonly model: string },
): AgentEvent => ({
  type: "identity",
  agentSessionId: session.agentSessionId,
  model: session.model,
  tools: [],
  commands: init.commands.filter((c) => offered(c, undefined)).map(toSlashCommand),
});

const commandsKey = (list: ReadonlyArray<SlashCommand>): string =>
  JSON.stringify(list.toSorted((x, y) => x.name.localeCompare(y.name)));

const commandStderr = (content: string): string | undefined => {
  const match = /^<local-command-stderr>([\s\S]*)<\/local-command-stderr>$/.exec(content.trim());
  const text = match?.[1]
    ?.replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .trim();
  return text === "" ? undefined : text;
};

export const makeMapper = (options: MapperOptions): ClaudeMapper => {
  const lanes = new Map<string, Lane>();
  const tools = new Map<string, ToolCall>();
  const background = new Set<string>();
  const ignoredTasks = new Set<string>();
  const starts = new Map<string, TaskUsageFields & { readonly startedAt: number }>();
  const startedAt = (id: string) => starts.get(id)?.startedAt;
  const now = options.now ?? Date.now;
  let reportedBack = false;
  const bashCommands = new Map<string, string>();
  const taskStarts = new Map<string, TaskStart>();
  const shells = new Map<string, { readonly toolCallId: string; sent?: string }>();
  const followShell = (taskId: string, toolCallId: string): void => {
    const call = tools.get(toolCallId);
    if (call === undefined || !SHELL_TOOLS.has(call.toolName) || shells.has(taskId)) return;
    shells.set(taskId, { toolCallId });
  };
  const unfollowCall = (toolCallId: string): void => {
    for (const [taskId, shell] of shells)
      if (shell.toolCallId === toolCallId) shells.delete(taskId);
  };
  const backgroundShells = new Map<
    string,
    { readonly toolCallId: string; sent?: string; listed: boolean }
  >();
  const isShellCall = (toolCallId: string): boolean => {
    const call = tools.get(toolCallId);
    return call !== undefined && SHELL_TOOLS.has(call.toolName);
  };
  const followBackgroundShell = (taskId: string, toolCallId: string): void => {
    if (backgroundShells.has(taskId)) return;
    backgroundShells.set(taskId, {
      toolCallId,
      listed: listed.some((task) => task.task_id === taskId),
    });
  };
  let listed: ReadonlyArray<{
    readonly task_id: string;
    readonly task_type: string;
    readonly description: string;
  }> = [];
  const firstListed = new Map<string, number>();
  let reportedTasks = "[]";
  let commands = new Map<string, ReportedCommand>();
  let skills: ReadonlySet<string> | undefined;
  let identity: Extract<AgentEvent, { type: "identity" }> | undefined;
  const offeredCommands = (names: ReadonlyArray<string>): ReadonlyArray<SlashCommand> =>
    names.flatMap((name) => {
      const known = commands.get(name);
      if (known === undefined) return [{ name, description: "" }];
      return offered(known, skills) ? [toSlashCommand(known)] : [];
    });
  let lastStatus: AgentStatus = "starting";
  let lastMode: PermissionMode | undefined;

  const status = (s: AgentStatus, detail?: string): AgentEvent => {
    lastStatus = s;
    return detail === undefined
      ? { type: "status", status: s }
      : { type: "status", status: s, detail };
  };
  const compactingStatus = (activity: CompactionActivity): AgentEvent => {
    lastStatus = "compacting";
    return { type: "status", status: "compacting", compaction: activity };
  };

  const reportBackground = (out: Array<AgentEvent>): void => {
    const tasks = listed.map((task): BackgroundTask => {
      const start = taskStarts.get(task.task_id);
      const seen = firstListed.get(task.task_id) ?? now();
      return {
        taskId: task.task_id,
        kind: TASK_KINDS[task.task_type] ?? "other",
        description: task.description,
        ...(start?.command === undefined ? {} : { command: start.command }),
        ...(start?.subagentType === undefined ? {} : { subagentType: start.subagentType }),
        ...(start?.toolCallId === undefined ? {} : { toolCallId: start.toolCallId }),
        startedAt: Math.min(seen, start?.startedAt ?? seen),
      };
    });
    const key = JSON.stringify(tasks);
    if (key === reportedTasks) return;
    reportedTasks = key;
    out.push({ type: "backgroundTasks", tasks });
  };

  const mode = (next: PermissionMode | undefined, out: Array<AgentEvent>): void => {
    if (next === undefined || next === lastMode) return;
    lastMode = next;
    out.push({ type: "mode", mode: next });
  };

  const lane = (key: string, out: Array<AgentEvent>): Lane => {
    const existing = lanes.get(key);
    if (existing) return existing;
    const created: Lane = {
      messageId: options.newMessageId(),
      step: undefined,
      model: undefined,
      modelConflict: false,
      streamed: new Set(),
      blocks: new Map(),
      seq: 0,
      agentMessageIds: [],
    };
    lanes.set(key, created);
    const initiated = key === MAIN && reportedBack;
    if (key === MAIN) {
      reportedBack = false;
      ledger.startTurn();
    }
    out.push(
      chunk(created, {
        type: "start",
        messageId: created.messageId,
        messageMetadata:
          key !== MAIN
            ? { agent: "claude", parentToolUseId: key }
            : initiated
              ? { agent: "claude", initiator: "agent" }
              : { agent: "claude" },
      }),
    );
    return created;
  };

  const step = (l: Lane, apiMessageId: string, out: Array<AgentEvent>): void => {
    if (l.step === apiMessageId) return;
    if (l.step !== undefined) out.push(chunk(l, { type: "finish-step" }));
    out.push(chunk(l, { type: "start-step" }));
    l.step = apiMessageId;
    l.blocks.clear();
  };

  const close = (
    key: string,
    out: Array<AgentEvent>,
    errorText = "The turn ended before the tool finished",
  ): void => {
    const l = lanes.get(key);
    if (!l) return;
    for (const block of l.blocks.values()) {
      if (block.kind === "text") out.push(chunk(l, { type: "text-end", id: block.id }));
      if (block.kind === "reasoning") out.push(chunk(l, { type: "reasoning-end", id: block.id }));
    }
    for (const [id, call] of tools) {
      if (call.lane !== key) continue;
      out.push(
        chunk(l, {
          type: "tool-output-error",
          toolCallId: id,
          errorText,
          ...toolFlags(call.dynamic),
        }),
      );
      tools.delete(id);
    }
    if (l.step !== undefined) out.push(chunk(l, { type: "finish-step" }));
    out.push(chunk(l, { type: "finish" }));
    lanes.delete(key);
  };

  const closeAll = (out: Array<AgentEvent>, all = false, errorText?: string): void => {
    for (const key of [...lanes.keys()].filter((k) => k !== MAIN)) {
      if (all || !background.has(key)) close(key, out, errorText);
    }
    close(MAIN, out, errorText);
    for (const [id, call] of tools) {
      if (all || !background.has(call.lane)) tools.delete(id);
    }
    if (all) background.clear();
  };

  const registerTool = (id: string, name: string, laneKey: string): ToolCall => {
    const call = { toolName: name, dynamic: isDynamicTool(name), lane: laneKey };
    tools.set(id, call);
    return call;
  };

  let compactSummary: string | undefined;
  let compaction: CompactionActivity | undefined;
  let lastCompaction: { readonly messageId: MessageId; readonly part: Chunk } | undefined;
  const ledger = makeUsageLedger(options);
  let apiError: string | undefined;
  let apiErrorText: string | undefined;
  const record = (apiMessageId: string, raw: unknown, out: Array<AgentEvent>): void => {
    const event = ledger.record(apiMessageId, raw);
    if (event !== undefined) out.push(event);
  };

  const onStreamEvent = (
    m: Extract<SDKMessage, { type: "stream_event" }>,
    out: Array<AgentEvent>,
  ) => {
    const key = m.parent_tool_use_id ?? MAIN;
    const e = m.event;
    if (e.type === "message_start") {
      const l = lane(key, out);
      step(l, e.message.id, out);
      if (key === MAIN)
        out.push(
          chunk(l, { type: "message-metadata", messageMetadata: { agentSessionId: m.session_id } }),
        );
      l.streamed.add(e.message.id);
      if (key === MAIN) {
        ledger.setWireModel(e.message.model);
        if (e.message.model !== undefined && e.message.model !== SYNTHETIC_MODEL) {
          l.modelConflict ||= l.model !== undefined && l.model !== e.message.model;
          l.model = e.message.model;
          out.push(
            chunk(l, {
              type: "message-metadata",
              messageMetadata: {
                model: l.model,
                ...(l.modelConflict ? { modelConflict: true } : {}),
              },
            }),
          );
        }
        record(e.message.id, e.message.usage, out);
      }
      return;
    }
    const l = lanes.get(key);
    if (!l || l.step === undefined) return;
    switch (e.type) {
      case "content_block_start": {
        const block = e.content_block;
        const id = `${l.step}:${e.index}`;
        if (block.type === "text") {
          l.blocks.set(e.index, { kind: "text", id });
          out.push(chunk(l, { type: "text-start", id }));
        } else if (block.type === "thinking") {
          l.blocks.set(e.index, { kind: "reasoning", id });
          out.push(chunk(l, { type: "reasoning-start", id }));
        } else if (block.type === "tool_use") {
          const call = registerTool(block.id, block.name, key);
          l.blocks.set(e.index, { kind: "tool", toolCallId: block.id });
          out.push(
            chunk(l, {
              type: "tool-input-start",
              toolCallId: block.id,
              toolName: block.name,
              ...toolFlags(call.dynamic),
            }),
          );
        }
        return;
      }
      case "content_block_delta": {
        const block = l.blocks.get(e.index);
        const d = e.delta;
        if (block?.kind === "text" && d.type === "text_delta") {
          out.push(chunk(l, { type: "text-delta", id: block.id, delta: d.text }));
        } else if (block?.kind === "reasoning" && d.type === "thinking_delta") {
          out.push(chunk(l, { type: "reasoning-delta", id: block.id, delta: d.thinking }));
        } else if (block?.kind === "tool" && d.type === "input_json_delta") {
          out.push(
            chunk(l, {
              type: "tool-input-delta",
              toolCallId: block.toolCallId,
              inputTextDelta: d.partial_json,
            }),
          );
        }
        return;
      }
      case "content_block_stop": {
        const block = l.blocks.get(e.index);
        if (block?.kind === "text") out.push(chunk(l, { type: "text-end", id: block.id }));
        if (block?.kind === "reasoning")
          out.push(chunk(l, { type: "reasoning-end", id: block.id }));
        l.blocks.delete(e.index);
        return;
      }
      case "message_delta":
        if (key === MAIN && l.step !== undefined) record(l.step, e.usage, out);
        return;
      default:
        return;
    }
  };

  const onAssistant = (m: Extract<SDKMessage, { type: "assistant" }>, out: Array<AgentEvent>) => {
    const key = m.parent_tool_use_id ?? MAIN;
    if (key === MAIN && m.message.model !== SYNTHETIC_MODEL) ledger.setWireModel(m.message.model);
    if (key === MAIN && m.error !== undefined) apiError = m.error;
    const l = lane(key, out);
    const apiId = m.message.id;
    if (key === MAIN)
      out.push(
        chunk(l, { type: "message-metadata", messageMetadata: { agentSessionId: m.session_id } }),
      );
    step(l, apiId, out);
    if (m.message.model !== SYNTHETIC_MODEL && l.model !== m.message.model) {
      l.modelConflict ||= key === MAIN && l.model !== undefined;
      l.model = m.message.model;
      out.push(
        chunk(l, {
          type: "message-metadata",
          messageMetadata: {
            model: l.model,
            ...(l.modelConflict ? { modelConflict: true } : {}),
          },
        }),
      );
    }
    if (!l.agentMessageIds.includes(m.uuid)) {
      l.agentMessageIds.push(m.uuid);
      out.push(
        chunk(l, {
          type: "message-metadata",
          messageMetadata: { agentMessageIds: [...l.agentMessageIds] },
        }),
      );
    }
    const failureReply =
      key === MAIN && m.error !== undefined && m.message.model === SYNTHETIC_MODEL;
    if (failureReply) {
      apiErrorText = m.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
    }
    const streamed = l.streamed.has(apiId) || failureReply;
    for (const block of m.message.content) {
      if (block.type === "tool_use") {
        const call = tools.get(block.id) ?? registerTool(block.id, block.name, key);
        const command = block.name === "Bash" ? asRecord(block.input)["command"] : undefined;
        if (typeof command === "string") bashCommands.set(block.id, command);
        out.push(
          chunk(l, {
            type: "tool-input-available",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input,
            ...toolFlags(call.dynamic),
          }),
        );
        if (block.name === "TodoWrite" && key === MAIN) {
          const items = todoPlan(block.input);
          if (items !== undefined) out.push({ type: "plan", items });
        }
      } else if (!streamed && block.type === "text" && block.text !== "") {
        const id = `${apiId}:c${l.seq++}`;
        out.push(chunk(l, { type: "text-start", id }));
        out.push(chunk(l, { type: "text-delta", id, delta: block.text }));
        out.push(chunk(l, { type: "text-end", id }));
      } else if (!streamed && block.type === "thinking" && block.thinking !== "") {
        const id = `${apiId}:c${l.seq++}`;
        out.push(chunk(l, { type: "reasoning-start", id }));
        out.push(chunk(l, { type: "reasoning-delta", id, delta: block.thinking }));
        out.push(chunk(l, { type: "reasoning-end", id }));
      }
    }
    if (key === MAIN) record(apiId, m.message.usage, out);
  };

  const onUser = (m: Extract<SDKMessage, { type: "user" }>, out: Array<AgentEvent>) => {
    const content = m.message.content;
    if ("isReplay" in m && m.isReplay) {
      const stderr = typeof content === "string" ? commandStderr(content) : undefined;
      if (stderr !== undefined) out.push(notice("warning", stderr));
      return;
    }
    if (typeof content === "string") return;
    const blocks: ReadonlyArray<ContentBlockParam> = content;
    const results = blocks.filter((block) => block.type === "tool_result");
    for (const block of results) {
      bashCommands.delete(block.tool_use_id);
      unfollowCall(block.tool_use_id);
      const call = tools.get(block.tool_use_id);
      const l = call && lanes.get(call.lane);
      if (!call || !l) continue;
      tools.delete(block.tool_use_id);
      const launched =
        results.length === 1 && asRecord(m.tool_use_result)["status"] === "async_launched";
      if (launched) {
        background.add(block.tool_use_id);
        lane(block.tool_use_id, out);
        const start = starts.get(block.tool_use_id);
        if (start !== undefined) out.push(subagentUsage(block.tool_use_id, "running", start));
      }
      if (!background.has(block.tool_use_id)) {
        close(block.tool_use_id, out);
        starts.delete(block.tool_use_id);
      }
      for (const image of resultImages(block.content)) {
        out.push({
          type: "toolImage",
          messageId: l.messageId,
          toolCallId: block.tool_use_id,
          ...image,
        });
      }
      if (block.is_error === true) {
        out.push(
          chunk(l, {
            type: "tool-output-error",
            toolCallId: block.tool_use_id,
            errorText: resultText(block.content),
            ...toolFlags(call.dynamic),
          }),
        );
      } else {
        const structured = results.length === 1 ? m.tool_use_result : undefined;
        out.push(
          chunk(l, {
            type: "tool-output-available",
            toolCallId: block.tool_use_id,
            output:
              structured === undefined || structured === null
                ? resultText(block.content)
                : withoutImageBytes(structured),
            ...toolFlags(call.dynamic),
          }),
        );
      }
    }
  };

  const onResult = (m: SDKResultMessage, out: Array<AgentEvent>) => {
    closeAll(
      out,
      false,
      turnEnd(m, apiError, apiErrorText).reason === "interrupted" ? "Cancelled" : undefined,
    );
    out.push(ledger.finish(m));
    out.push({ type: "turnEnd", ...turnEnd(m, apiError, apiErrorText) });
    apiError = undefined;
    apiErrorText = undefined;
  };

  const onSystem = (m: Extract<SDKMessage, { type: "system" }>, out: Array<AgentEvent>) => {
    switch (m.subtype) {
      case "init":
        ledger.setSessionModel(m.model);
        skills = new Set(m.skills);
        identity = {
          type: "identity",
          agentSessionId: m.session_id,
          model: m.model,
          tools: [...m.tools],
          commands: offeredCommands(m.slash_commands),
        };
        out.push(identity);
        mode(m.permissionMode, out);
        return;
      case "commands_changed": {
        commands = new Map(m.commands.map((c) => [c.name, c]));
        if (identity === undefined) return;
        const next = offeredCommands(m.commands.map((c) => c.name));
        if (commandsKey(next) === commandsKey(identity.commands)) return;
        identity = { ...identity, model: ledger.sessionModel ?? identity.model, commands: next };
        out.push(identity);
        return;
      }
      case "session_state_changed":
        if (m.state === "running") out.push(status("running"));
        if (m.state === "idle") {
          const unfinished = lanes.has(MAIN);
          const failure =
            apiError !== undefined && apiErrorText !== undefined
              ? {
                  reason: "error" as const,
                  error: apiErrorText,
                  failure: claudeFailure(undefined, apiError, apiErrorText),
                }
              : undefined;
          closeAll(out, false, failure === undefined ? "Cancelled" : undefined);
          if (unfinished)
            out.push({ type: "turnEnd", ...(failure ?? { reason: "interrupted" as const }) });
          apiError = undefined;
          apiErrorText = undefined;
          out.push(status("idle"));
        }
        return;
      case "status":
        mode(m.permissionMode, out);
        if (m.status === "compacting") {
          compactSummary = undefined;
          compaction = {
            startedAt: now(),
            ...(ledger.contextTokens === undefined ? {} : { preTokens: ledger.contextTokens }),
          };
          out.push(compactingStatus(compaction));
        } else if (m.status === null && lastStatus === "compacting") {
          if (m.compact_result === "failed") {
            compaction = undefined;
            out.push(status("running"));
            out.push(
              notice(
                "warning",
                `Compaction failed${m.compact_error ? `: ${m.compact_error}` : ""}`,
              ),
            );
          } else if (compaction === undefined) {
            out.push(status("running"));
          }
        }
        return;
      case "informational": {
        if (m.tag !== "hook_no_verdict") return;
        const detail = (m as { readonly hook_no_verdict?: { readonly timed_out?: boolean } })
          .hook_no_verdict;
        out.push(
          notice(
            "warning",
            detail?.timed_out === true
              ? "A tool check timed out without an answer, so Claude went ahead with the call. Other checks and rules still applied."
              : "A tool check failed without an answer, so Claude went ahead with the call. Other checks and rules still applied.",
          ),
        );
        return;
      }
      case "api_retry":
        out.push(
          status(
            "retrying",
            `API retry ${m.attempt}/${m.max_retries}${m.error_status ? ` (HTTP ${m.error_status})` : ""}`,
          ),
        );
        return;
      case "compact_boundary": {
        const l = lane(MAIN, out);
        const { trigger, pre_tokens, post_tokens } = m.compact_metadata;
        const preTokens = int(pre_tokens);
        const postTokens = int(post_tokens);
        if (postTokens !== undefined) ledger.setContextTokens(postTokens);
        const summary = compactSummary;
        compactSummary = undefined;
        const part: Chunk = {
          type: "data-compaction",
          id: `compaction:${m.uuid}`,
          data: {
            trigger,
            ...(preTokens === undefined ? {} : { preTokens }),
            ...(postTokens === undefined ? {} : { postTokens }),
            at: now(),
            ...(summary === undefined ? {} : { summary }),
          },
        };
        lastCompaction = summary === undefined ? { messageId: l.messageId, part } : undefined;
        out.push(chunk(l, part));
        if (compaction !== undefined && lastStatus === "compacting") out.push(status("running"));
        compaction = undefined;
        return;
      }
      case "task_started":
        if (m.is_backgrounded === true && m.tool_use_id !== undefined) {
          background.add(m.tool_use_id);
        }
        if (m.task_type === "local_bash" && m.tool_use_id !== undefined) {
          if (m.is_backgrounded !== true) followShell(m.task_id, m.tool_use_id);
          else if (isShellCall(m.tool_use_id)) followBackgroundShell(m.task_id, m.tool_use_id);
        }
        if (m.ambient !== true) {
          const command = m.tool_use_id === undefined ? undefined : bashCommands.get(m.tool_use_id);
          taskStarts.set(m.task_id, {
            startedAt: now(),
            toolCallId: m.tool_use_id,
            subagentType: m.subagent_type,
            command,
            ...(m.task_type === "local_bash" &&
            m.tool_use_id !== undefined &&
            isShellCall(m.tool_use_id)
              ? { shell: true }
              : {}),
          });
          if (listed.some((task) => task.task_id === m.task_id)) reportBackground(out);
        }
        if (
          m.ambient === true ||
          m.skip_transcript === true ||
          (m.task_type !== undefined && m.task_type !== "local_agent")
        ) {
          ignoredTasks.add(m.task_id);
        } else if (m.tool_use_id !== undefined) {
          const start = {
            startedAt: now(),
            ...(m.subagent_type === undefined ? {} : { subagent_type: m.subagent_type }),
          };
          starts.set(m.tool_use_id, start);
          out.push(subagentUsage(m.tool_use_id, "running", start));
        }
        return;
      case "background_tasks_changed": {
        listed = m.tasks.filter((task) => task.ambient !== true);
        const ids = new Set(listed.map((task) => task.task_id));
        for (const id of firstListed.keys()) if (!ids.has(id)) firstListed.delete(id);
        for (const id of ids) if (!firstListed.has(id)) firstListed.set(id, now());
        for (const [id, shell] of backgroundShells) {
          if (ids.has(id)) shell.listed = true;
          else if (shell.listed) backgroundShells.delete(id);
        }
        reportBackground(out);
        return;
      }
      case "task_progress": {
        const id = m.tool_use_id;
        if (id === undefined || ignoredTasks.has(m.task_id)) return;
        out.push(subagentUsage(id, "running", { ...m, startedAt: startedAt(id) }));
        return;
      }
      case "task_updated": {
        const ended = m.patch.status;
        if (ended === "completed" || ended === "failed" || ended === "killed") {
          shells.delete(m.task_id);
          backgroundShells.delete(m.task_id);
          return;
        }
        if (m.patch.is_backgrounded !== true) return;
        const foreground = shells.get(m.task_id);
        shells.delete(m.task_id);
        const start = taskStarts.get(m.task_id);
        if (foreground !== undefined) followBackgroundShell(m.task_id, foreground.toolCallId);
        else if (start?.shell === true && start.toolCallId !== undefined)
          followBackgroundShell(m.task_id, start.toolCallId);
        return;
      }
      case "task_notification": {
        shells.delete(m.task_id);
        backgroundShells.delete(m.task_id);
        if (!lanes.has(MAIN) && m.ambient !== true && m.skip_transcript !== true) {
          reportedBack = true;
        }
        taskStarts.delete(m.task_id);
        const id = m.tool_use_id;
        if (id === undefined) return;
        if (m.ambient !== true && m.skip_transcript !== true && !ignoredTasks.has(m.task_id)) {
          out.push(
            subagentUsage(id, m.status, {
              startedAt: startedAt(id),
              ...(m.usage === undefined ? {} : { usage: m.usage }),
            }),
          );
        }
        ignoredTasks.delete(m.task_id);
        starts.delete(id);
        if (!background.delete(id)) return;
        close(id, out);
        for (const [toolId, call] of tools) if (call.lane === id) tools.delete(toolId);
        return;
      }
      default:
        return;
    }
  };

  const map = (message: SDKMessage): Array<AgentEvent> => {
    const out: Array<AgentEvent> = [];
    switch (message.type) {
      case "stream_event":
        onStreamEvent(message, out);
        break;
      case "assistant":
        onAssistant(message, out);
        break;
      case "user":
        onUser(message, out);
        break;
      case "result":
        onResult(message, out);
        break;
      case "system":
        onSystem(message, out);
        break;
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        const credits =
          info.isUsingOverage === true ||
          info.overageInUse === true ||
          (info.status === "rejected" &&
            (info.overageStatus === "allowed" || info.overageStatus === "allowed_warning"));
        if (info.status === "rejected" && credits) {
          const window = info.rateLimitType;
          if (window !== "five_hour" && window !== "seven_day") break;
          out.push({
            type: "rateLimit",
            status: info.overageStatus === "allowed_warning" ? "warning" : "allowed",
            window,
            utilization: info.utilization ?? 1,
            ...(info.resetsAt ? { resetsAt: info.resetsAt * 1000 } : {}),
            credits: true,
          });
          break;
        }
        if (info.status === "allowed") {
          const window = info.rateLimitType;
          if (info.utilization === undefined || (window !== "five_hour" && window !== "seven_day"))
            break;
          out.push({
            type: "rateLimit",
            status: "allowed",
            window,
            utilization: info.utilization,
            ...(info.resetsAt ? { resetsAt: info.resetsAt * 1000 } : {}),
            ...(credits ? { credits: true as const } : {}),
          });
          break;
        }
        if (info.status === "rejected") out.push(status("retrying"));
        out.push({
          type: "rateLimit",
          status: info.status === "rejected" ? "rejected" : "warning",
          window: info.rateLimitType ?? "usage",
          ...(info.utilization === undefined ? {} : { utilization: info.utilization }),
          ...(info.resetsAt ? { resetsAt: info.resetsAt * 1000 } : {}),
          ...(credits ? { credits: true as const } : {}),
        });
        break;
      }
      case "tool_progress":
        if (message.heartbeat === true) {
          if (lastStatus === "running") out.push(status("running"));
          break;
        }
        if (message.task_id !== undefined) followShell(message.task_id, message.tool_use_id);
        break;
      case "auth_status":
        if (message.error) {
          out.push(status("error"));
          out.push(notice("error", `${message.error}. ${DEFAULT_SIGN_IN_HINT}`));
        }
        break;
      default:
        break;
    }
    return out;
  };

  return {
    map,
    setCommands: (next) => {
      commands = new Map(next.map((c) => [c.name, c]));
    },
    setAdvertisedRate: ledger.setAdvertisedRate,
    setSessionModel: ledger.setSessionModel,
    compacting: (trigger) => {
      if (compaction === undefined || compaction.trigger === trigger) return [];
      compaction = { ...compaction, trigger };
      return lastStatus === "compacting" ? [compactingStatus(compaction)] : [];
    },
    compacted: (raw) => {
      const summary = summaryText(raw);
      if (summary === undefined) return [];
      const last = lastCompaction;
      lastCompaction = undefined;
      const open = lanes.get(MAIN);
      if (last === undefined || open?.messageId !== last.messageId) {
        compactSummary = summary;
        return [];
      }
      const part = last.part as Extract<Chunk, { type: "data-compaction" }>;
      return [chunk(open, { ...part, data: { ...part.data, summary } })];
    },
    runningShells: () => {
      for (const [taskId, shell] of shells) if (!tools.has(shell.toolCallId)) shells.delete(taskId);
      return [
        ...[...shells].map(([taskId, shell]) => ({ taskId, toolCallId: shell.toolCallId })),
        ...[...backgroundShells].map(([taskId, shell]) => ({
          taskId,
          toolCallId: shell.toolCallId,
          background: true,
        })),
      ];
    },
    shellOutput: (taskId, read) => {
      if (typeof read.output !== "string") return [];
      const output = readText(read);
      const backgroundShell = backgroundShells.get(taskId);
      if (backgroundShell !== undefined) {
        if (output === "" || output === backgroundShell.sent) return [];
        backgroundShell.sent = output;
        return [
          {
            type: "backgroundOutput",
            taskId,
            toolCallId: backgroundShell.toolCallId,
            output,
          },
        ];
      }
      const shell = shells.get(taskId);
      const call = shell === undefined ? undefined : tools.get(shell.toolCallId);
      const l = call === undefined ? undefined : lanes.get(call.lane);
      if (shell === undefined || call === undefined || l === undefined) {
        shells.delete(taskId);
        return [];
      }
      if (output === "" || output === shell.sent) return [];
      shell.sent = output;
      return [
        chunk(l, {
          type: "tool-output-available",
          toolCallId: shell.toolCallId,
          output: { stdout: output, stderr: "", interrupted: false },
          preliminary: true,
          ...toolFlags(call.dynamic),
        }),
      ];
    },
    flush: () => {
      const out: Array<AgentEvent> = [];
      closeAll(out, true);
      shells.clear();
      backgroundShells.clear();
      return out;
    },
    sent: () => {
      reportedBack = false;
    },
    /** A delayed steering reply starts after the runtime timed out its interrupted iteration. */
    continued: () => {
      reportedBack = true;
    },
  };
};

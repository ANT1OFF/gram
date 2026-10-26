import type {
  SDKControlInitializeResponse,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
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

/*
 * Message shape
 * - One assistant UIMessage per turn: `start` at its first output, `finish` at `result` (or `idle`
 *   if no result arrives). Each API response (`msg_…` id) is a step (`start-step`/`finish-step`),
 *   so tool results, which arrive in later SDK `user` messages, still land on the same message.
 * - Subagent output (`parent_tool_use_id` set) is a separate UIMessage per parent tool call, with
 *   `metadata.parentToolUseId`; the UI nests it under that Task/Agent card. It finishes when the
 *   parent's tool result arrives, or, for a subagent launched in the background (the result is
 *   only `async_launched`), at its `task_notification`, so its lane outlives the turn.
 * - With `includePartialMessages`, text/reasoning/tool input stream from `stream_event`s and the
 *   duplicate content of the complete `assistant` messages is skipped; tool calls still take their
 *   final input from the complete message (`tool-input-available`). Without partial messages the
 *   complete messages are emitted whole.
 * - Each complete `assistant` message's `uuid` (one per content block) is appended to its
 *   UIMessage's `metadata.agentMessageIds`; the last one is the rewind point after that message.
 * - A foreground shell command reports no output until it exits, but the CLI registers it as a
 *   `local_bash` task once it has run a few seconds (`task_started`, `is_backgrounded: false`).
 *   The session reads that task's output tail (`getTaskOutput`) while the call runs, and each
 *   new read becomes a preliminary `tool-output-available` for the Bash call, the same snapshot
 *   the Codex mapper sends; the call's result replaces it.
 * - A background shell (`run_in_background`, or moved there on timeout) has its call's result at
 *   once, so its reads become `backgroundOutput` events beside the transcript instead, from its
 *   `task_started` (or move) until its task ends, leaves the CLI's level, or the query ends.
 */

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

/** A shell command, by the task id the CLI gave it, and its tool call. */
interface RunningShell {
  readonly taskId: string;
  readonly toolCallId: string;
  /** It runs in the background: its call has its result, and reads become `backgroundOutput`. */
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

/**
 * A read's text: a tail cut from a longer output starts mid-line, so it shows from its first whole
 * line, or whole when it is all one line.
 */
const readText = (read: TaskOutputRead): string => {
  const cut = read.truncated ? read.output.indexOf("\n") : -1;
  const trimmed = cut === -1 ? read.output : read.output.slice(cut + 1);
  return trimmed === "" ? read.output : trimmed;
};

/** The tools whose running command the CLI keeps as a `local_bash` task. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

type OpenBlock =
  | { readonly kind: "text" | "reasoning"; readonly id: string }
  | { readonly kind: "tool"; readonly toolCallId: string };

interface Lane {
  readonly messageId: MessageId;
  /** Open step: the API message id. */
  step: string | undefined;
  /** Wire model id of the last assistant message in this lane, once reported. */
  model: string | undefined;
  modelConflict: boolean;
  /** API message ids whose content arrived as stream events. */
  readonly streamed: Set<string>;
  /** Open streamed content blocks by index. */
  readonly blocks: Map<number, OpenBlock>;
  seq: number;
  /** SDK `uuid`s of the complete assistant messages in this UIMessage, in order. */
  readonly agentMessageIds: Array<string>;
}

interface ToolCall {
  readonly toolName: string;
  readonly dynamic: boolean;
  readonly lane: string;
}

const MAIN = "";
/** The model the CLI names on a message no model wrote. */
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

/**
 * The summary in a `PostCompact` hook's `compact_summary`: the model writes its working notes in an
 * `<analysis>` block ahead of the `<summary>` the session carries on from, and only the second is
 * the summary. `undefined` when nothing is left.
 */
const summaryText = (raw: string): string | undefined => {
  // `indexOf` rather than a lazy regex, which backtracks polynomially on repeated open tags.
  const open = raw.indexOf("<summary>");
  let text: string;
  if (open !== -1) {
    const from = open + "<summary>".length;
    const close = raw.indexOf("</summary>", from);
    text = raw.slice(from, close === -1 ? undefined : close);
  } else {
    // Drop working notes, including a truncated block: its remaining text isn't a summary.
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

/** Text of a `tool_result` content (string or content blocks). */
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

/** The base64 `image` blocks of a `tool_result` content: a `Read` of a PNG, an MCP screenshot. */
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

/**
 * A structured tool output without its image bytes, which travel as `toolImage` events instead: the
 * output is stored in the transcript and replayed to every client, and the CLI repeats a read
 * image in it as `file.base64`, or as `image` blocks when the output is the content array itself.
 */
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

/** TodoWrite's statuses, mapped to the shared thread plan. */
const TODO_STATUS: Readonly<Record<string, PlanItem["status"]>> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

/** TodoWrite's `todos` as a plan; `undefined` for input that isn't a todo list. */
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

/** What `task_started` says about a task that the level (`background_tasks_changed`) doesn't. */
interface TaskStart {
  readonly startedAt: number;
  readonly toolCallId?: string | undefined;
  readonly subagentType?: string | undefined;
  readonly command?: string | undefined;
  /** It is a `local_bash` task started by a shell tool call (Bash, PowerShell). */
  readonly shell?: boolean;
}

/**
 * How a result ends the turn. `apiError` is the `error` the SDK put on the turn's synthetic API-error
 * message, which with the result's `api_error_status` classifies the failure.
 */
const turnEnd = (
  result: SDKResultMessage,
  apiError?: string,
): {
  readonly reason: TurnEndReason;
  readonly error?: string;
  readonly failure?: AgentFailure;
} => {
  const terminal = asRecord(result)["terminal_reason"];
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

/** A command list, comparable whatever order it was listed in. */
const commandsKey = (list: ReadonlyArray<SlashCommand>): string =>
  JSON.stringify(list.toSorted((x, y) => x.name.localeCompare(y.name)));

/** What a local command wrote to stderr, from the replayed user message the CLI reports it in. */
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
  /** Subagent tool calls running in the background: their lanes outlive the turn. */
  const background = new Set<string>();
  /** Task ids whose progress isn't a subagent's: housekeeping, watchers, backgrounded shells. */
  const ignoredTasks = new Set<string>();
  /**
   * Each running subagent's start, by its tool call: `task_started` carries no time, and every later
   * snapshot repeats it.
   */
  const starts = new Map<string, TaskUsageFields & { readonly startedAt: number }>();
  const startedAt = (id: string) => starts.get(id)?.startedAt;
  const now = options.now ?? Date.now;
  /** A background task finished between turns, so the CLI answers without a send. */
  let reportedBack = false;
  /** Bash commands by tool call, until the call's result: `task_started` names only the call. */
  const bashCommands = new Map<string, string>();
  /** Each task's `task_started`, by task id, until its `task_notification`. */
  const taskStarts = new Map<string, TaskStart>();
  /**
   * Foreground shell commands by task id, until the call's result: their tool call, and the last
   * output sent for it.
   */
  const shells = new Map<string, { readonly toolCallId: string; sent?: string }>();
  /** Follows a shell tool call's output under `taskId`, while the call is still running. */
  const followShell = (taskId: string, toolCallId: string): void => {
    const call = tools.get(toolCallId);
    if (call === undefined || !SHELL_TOOLS.has(call.toolName) || shells.has(taskId)) return;
    shells.set(taskId, { toolCallId });
  };
  const unfollowCall = (toolCallId: string): void => {
    for (const [taskId, shell] of shells)
      if (shell.toolCallId === toolCallId) shells.delete(taskId);
  };
  /**
   * Background shell commands by task id, until their task ends: their tool call, which already
   * has its final result, the last output sent for them, and whether the CLI has listed them yet.
   */
  const backgroundShells = new Map<
    string,
    { readonly toolCallId: string; sent?: string; listed: boolean }
  >();
  /** Whether `toolCallId` is a shell tool call this mapper knows of. */
  const isShellCall = (toolCallId: string): boolean => {
    const call = tools.get(toolCallId);
    return call !== undefined && SHELL_TOOLS.has(call.toolName);
  };
  /** Follows a backgrounded shell call's output under `taskId`, while its task runs. */
  const followBackgroundShell = (taskId: string, toolCallId: string): void => {
    if (backgroundShells.has(taskId)) return;
    backgroundShells.set(taskId, {
      toolCallId,
      listed: listed.some((task) => task.task_id === taskId),
    });
  };
  /** The background tasks the CLI last listed, leaving out the ambient ones. */
  let listed: ReadonlyArray<{
    readonly task_id: string;
    readonly task_type: string;
    readonly description: string;
  }> = [];
  /** When each listed task was first listed. */
  const firstListed = new Map<string, number>();
  /** The last `backgroundTasks` event's tasks, to send only a change. */
  let reportedTasks = "[]";
  let commands = new Map<string, ReportedCommand>();
  /** `system/init`'s skills, which tell the bundled skills from the CLI's other `builtin` commands. */
  let skills: ReadonlySet<string> | undefined;
  /** The last `system/init`, which a changed command list is reported against. */
  let identity: Extract<AgentEvent, { type: "identity" }> | undefined;
  /** The thread's commands from `names`, those the CLI didn't describe kept with no description. */
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

  /** Reports the listed background tasks, joined to what their `task_started` said, if they changed. */
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
        // The level usually arrives a moment before `task_started`, but a shell the CLI moves to
        // the background when it outruns its timeout started long before it was listed.
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

  /** Closes every lane, except those of subagents still running in the background unless `all`. */
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

  /** A `PostCompact` summary waiting for its `compact_boundary`. */
  let compactSummary: string | undefined;
  /** The compaction under way, from its `compacting` status to its `compact_boundary`. */
  let compaction: CompactionActivity | undefined;
  /** The last compaction marker sent without a summary, in case its hook comes after it. */
  let lastCompaction: { readonly messageId: MessageId; readonly part: Chunk } | undefined;
  const ledger = makeUsageLedger(options);
  /** The `error` on this turn's synthetic API-error message, for `turnEnd`. */
  let apiError: string | undefined;
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
      // The request's final output count, which its complete assistant message never carries.
      case "message_delta":
        if (key === MAIN && l.step !== undefined) record(l.step, e.usage, out);
        return;
      default:
        return;
    }
  };

  const onAssistant = (m: Extract<SDKMessage, { type: "assistant" }>, out: Array<AgentEvent>) => {
    const key = m.parent_tool_use_id ?? MAIN;
    // A local command's reply (`/context`) is `<synthetic>`: no window or price to read from it.
    if (key === MAIN && m.message.model !== SYNTHETIC_MODEL) ledger.setWireModel(m.message.model);
    if (key === MAIN && m.error !== undefined) apiError = m.error;
    const l = lane(key, out);
    const apiId = m.message.id;
    if (key === MAIN)
      out.push(
        chunk(l, { type: "message-metadata", messageMetadata: { agentSessionId: m.session_id } }),
      );
    step(l, apiId, out);
    // A subagent that inherits the default model names it nowhere else: its Task input has no model.
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
      // Metadata merges key by key but arrays replace, so send the whole list.
      out.push(
        chunk(l, {
          type: "message-metadata",
          messageMetadata: { agentMessageIds: [...l.agentMessageIds] },
        }),
      );
    }
    const streamed = l.streamed.has(apiId);
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
        // The main conversation's todo list is the thread's plan; a subagent's is its own business.
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
      // A command whose `!`-shell step failed (`/security-review` with no `origin`) says so only
      // here, and its turn ends with nothing else to show.
      const stderr = typeof content === "string" ? commandStderr(content) : undefined;
      if (stderr !== undefined) out.push(notice("warning", stderr));
      return;
    }
    if (typeof content === "string") return;
    const results = content.filter((block) => block.type === "tool_result");
    for (const block of results) {
      // Its `task_started`, if it has one, came before the result and took the command.
      bashCommands.delete(block.tool_use_id);
      // The result is the command's whole output, or its move to the background.
      unfollowCall(block.tool_use_id);
      const call = tools.get(block.tool_use_id);
      const l = call && lanes.get(call.lane);
      if (!call || !l) continue;
      tools.delete(block.tool_use_id);
      // Close the subagent transcript before its parent card completes, unless the result is only
      // a background launch: that subagent keeps streaming until its `task_notification`.
      const launched =
        results.length === 1 && asRecord(m.tool_use_result)["status"] === "async_launched";
      if (launched) {
        background.add(block.tool_use_id);
        // Opened now rather than at its first message, which can come after the turn has ended:
        // an open lane is what tells the runtime a subagent is still working.
        lane(block.tool_use_id, out);
        // The start went out on the reply before the lane existed; the lane gets its own copy.
        const start = starts.get(block.tool_use_id);
        if (start !== undefined) out.push(subagentUsage(block.tool_use_id, "running", start));
      }
      if (!background.has(block.tool_use_id)) {
        close(block.tool_use_id, out);
        // A foreground run can end here with no `task_notification` to forget its start.
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
    closeAll(out, false, turnEnd(m, apiError).reason === "interrupted" ? "Cancelled" : undefined);
    out.push(ledger.finish(m));
    out.push({ type: "turnEnd", ...turnEnd(m, apiError) });
    apiError = undefined;
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
        // Skills found as the agent works, and the list again after `/reload-skills`. It comes
        // several times a turn, mostly unchanged.
        commands = new Map(m.commands.map((c) => [c.name, c]));
        if (identity === undefined) return;
        const next = offeredCommands(m.commands.map((c) => c.name));
        if (commandsKey(next) === commandsKey(identity.commands)) return;
        identity = { ...identity, model: ledger.sessionModel ?? identity.model, commands: next };
        out.push(identity);
        return;
      }
      case "session_state_changed":
        // `requires_action` is reported with the request itself (approval vs input).
        if (m.state === "running") out.push(status("running"));
        if (m.state === "idle") {
          // A CLI iteration can go idle without a result. Its open lane is the evidence;
          // after a real result the lane is closed, so its idle tail adds no second turn end.
          const unfinished = lanes.has(MAIN);
          closeAll(out, false, "Cancelled");
          if (unfinished) out.push({ type: "turnEnd", reason: "interrupted" });
          out.push(status("idle"));
        }
        return;
      case "status":
        mode(m.permissionMode, out);
        if (m.status === "compacting") {
          // A summary from a compaction that never reached its boundary isn't this one's.
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
          // A success stays `compacting` until its boundary brings the marker, so the live line
          // hands over to it without a gap (CLI 2.1.285 sends an `init` in between).
        }
        return;
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
        // The meter would otherwise keep the last request's prompt until the next one: to the end
        // of a `/compact`, which sends none, the turn's usage still showed the context it dropped.
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
        // A foreground command that has run a while: the CLI now keeps its output where
        // `getTaskOutput` reads it, and its call shows it as interim output. A backgrounded one
        // has its result already, so its output goes beside the transcript instead.
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
        // The CLI's own level of what is running in the background, shells included, rather than
        // pairing `task_started` with `task_notification`: a missed edge can't strand a task.
        listed = m.tasks.filter((task) => task.ambient !== true);
        const ids = new Set(listed.map((task) => task.task_id));
        for (const id of firstListed.keys()) if (!ids.has(id)) firstListed.delete(id);
        for (const id of ids) if (!firstListed.has(id)) firstListed.set(id, now());
        // A background shell that has left the level has ended, whatever edge is still to come.
        // One not listed yet may be about to join: the level and `task_started` come in either order.
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
          // Ended: nothing more to follow.
          shells.delete(m.task_id);
          backgroundShells.delete(m.task_id);
          return;
        }
        if (m.patch.is_backgrounded !== true) return;
        // Moved to the background when it outran its timeout: its call's result comes now, and
        // the output it goes on writing is followed beside the transcript.
        const foreground = shells.get(m.task_id);
        shells.delete(m.task_id);
        const start = taskStarts.get(m.task_id);
        // Not its last interim output: that was the call's, which its result now replaces.
        if (foreground !== undefined) followBackgroundShell(m.task_id, foreground.toolCallId);
        else if (start?.shell === true && start.toolCallId !== undefined)
          followBackgroundShell(m.task_id, start.toolCallId);
        return;
      }
      case "task_notification": {
        shells.delete(m.task_id);
        backgroundShells.delete(m.task_id);
        // Between turns the CLI answers a finished background task with a turn of its own: a
        // subagent's report, or a shell's exit, including one it moved to the background itself
        // when it outran its timeout.
        if (!lanes.has(MAIN) && m.ambient !== true && m.skip_transcript !== true) {
          reportedBack = true;
        }
        taskStarts.delete(m.task_id);
        const id = m.tool_use_id;
        if (id === undefined) return;
        if (m.ambient !== true && m.skip_transcript !== true && !ignoredTasks.has(m.task_id)) {
          // Not `m.summary`: on a notification that is the subagent's whole report, which is
          // already in its transcript and unbounded in length.
          out.push(
            subagentUsage(id, m.status, {
              startedAt: startedAt(id),
              ...(m.usage === undefined ? {} : { usage: m.usage }),
            }),
          );
        }
        ignoredTasks.delete(m.task_id);
        starts.delete(id);
        // A background subagent is done: close its transcript.
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
        // Past the window on extra usage: Claude goes on, so the window is spent but no stop.
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
          // A reading for the usage meter only, never a notice. It comes between warnings for the
          // same window too, so without a share and a window it says nothing about either.
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
        // Only elapsed time, no output, but it names the task a running shell writes to. CLI
        // 2.1.296 didn't send it on a local lane; `task_started` names the task there.
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
      // Recorded on CLI 2.1.285 the hook runs first; should that turn around, the marker already
      // sent is sent again with the summary, as long as its message is still the open one.
      const open = lanes.get(MAIN);
      if (last === undefined || open?.messageId !== last.messageId) {
        compactSummary = summary;
        return [];
      }
      const part = last.part as Extract<Chunk, { type: "data-compaction" }>;
      return [chunk(open, { ...part, data: { ...part.data, summary } })];
    },
    runningShells: () => {
      // A call can end with no result or notification for its task (an interrupt closes it).
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
      // The query is over, so background subagents won't report back either, and the CLI that
      // ran the background shells is gone.
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

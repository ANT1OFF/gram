import { codexRateLimits } from "./limits.ts";
export { codexRateLimits } from "./limits.ts";
import {
  RequestId,
  splitToolImageOutput,
  type AgentEvent,
  type AgentFailure,
  type AgentStatus,
  type BackgroundTask,
  patchChangeHunks,
  type FileChange,
  type MessageId,
  type PlanItem,
  type GramUIMessageChunk,
  type TokenUsage,
} from "@gram/contracts";
import { codexFailure, type CodexTurnError } from "../failure.ts";
import { startupDiagnostic } from "./startup-diagnostic.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import {
  addCodexCounts,
  codexCounts,
  makeCodexUsageLedger,
  validCodexCounts,
  codexTelemetryVersion,
  type CodexUsageBasis,
} from "./usage.ts";

/*
 * Message shape
 * - One assistant UIMessage per turn, opened at `turn/started` and finished at `turn/completed`.
 *   `metadata.agentMessageIds` holds the turn id, the anchor Codex forks (`lastTurnId`) and reverts
 *   (`beforeTurnId`) by.
 * - Agent messages become text parts and reasoning items reasoning parts, both streamed by delta.
 * - Commands, file changes, web searches and MCP calls become provider-executed dynamic tool parts
 *   under Claude's tool names (`Bash`, `Edit`, `WebSearch`, `mcp__<server>__<tool>`), so cards and
 *   the activity line read them the same way.
 * - A known unified-exec PTY keeps its original command card after the reply finishes. Output
 *   snapshots are preliminary until its exit item; background levels keep its session visible.
 * - Collaboration invocation results expose the last reported child states, not child streams.
 * - Usage is the growth of `tokenUsage.total` over the turn; Codex reports no cost.
 * - Codex reports the thread idle before `turn/completed`; idle is held back until the turn ends.
 */

export interface CodexMapperOptions {
  /** Only a newly created, unforked provider session has a proven zero baseline. */
  readonly freshSession?: boolean;
  /** The provider thread this mapper owns; child and sibling events must stay in their scope. */
  readonly threadId?: string;
  /** Stable home/profile identity for startup notices. Omitted by older callers. */
  readonly diagnosticScope?: string;
  /** Config warnings without a reported path are local to this folder. */
  readonly diagnosticCwd?: string;
  readonly newMessageId: () => MessageId;
  /**
   * True while the session answers Codex's approval requests itself (the outward gate in bypass)
   * and has no approval card up. Codex flags `waitingOnApproval` before it sends the request, so
   * without this every command the adapter accepts unseen would flash the thread to "needs you".
   */
  readonly answersApprovals?: () => boolean;
  /** The session runs on a Gram gateway profile, which changes what a 429 means. */
  readonly gateway?: boolean;
  /** The clock a compaction's `at` is read from; `Date.now` when left out. */
  readonly now?: () => number;
  /** Safe lifecycle metadata only; the session logs it asynchronously. */
  readonly onCompaction?: (phase: CodexCompactionPhase) => void;
}

export interface CodexCompactionPhase {
  readonly phase: "started" | "completed" | "failed" | "interrupted" | "unfinished";
  readonly turnId: string;
  readonly itemId: string;
  readonly at: number;
  readonly startedAt: number;
  readonly trigger: "manual" | "auto";
  readonly preTokens?: number;
  readonly elapsedMs: number;
  /** Newer CLIs provide the provider lifecycle timestamp; older versions omit it. */
  readonly providerAt?: number;
  /** Provider-to-adapter lag; a negative value indicates clock skew. */
  readonly receivedAfterMs?: number;
}

type Compaction = Pick<CodexCompactionPhase, "startedAt" | "trigger" | "preTokens">;

export interface CodexMapper {
  map(notification: ServerNotification): Array<AgentEvent>;
  /** A file change item's patches, for the approval card. */
  changes(itemId: string): ReadonlyArray<FileUpdateChange> | undefined;
  /** Finishes an open turn, e.g. when the app-server exits mid-turn. */
  flush(): Array<AgentEvent>;
  /** The status for an approval card going up, when `answersApprovals` kept Codex's own flag back. */
  awaitingApproval(): Array<AgentEvent>;
  /**
   * The session sent `thread/compact/start` (`true`): the next compaction is the user's, not
   * Codex's; or the request failed (`false`). A turn ending takes it back too.
   */
  compactionRequested(pending: boolean): void;
}

type Chunk = GramUIMessageChunk;

interface PartState {
  readonly kind: "text" | "reasoning";
  emitted: number;
  ended: boolean;
}

interface Turn {
  readonly id: string;
  readonly messageId: MessageId;
  readonly parts: Map<string, PartState>;
  readonly tools: Set<string>;
  readonly webInputs: Map<string, string>;
  readonly imagePaths: Map<string, string>;
  readonly pendingTools: Set<string>;
  usage: TokenUsage | undefined;
  partialUsage: boolean;
  usageBasis: CodexUsageBasis | undefined;
  error: string | undefined;
  failure: AgentFailure | undefined;
}

const TOOL_FLAGS = { providerExecuted: true, dynamic: true } as const;
const commandKey = (turnId: string, itemId: string) => JSON.stringify([turnId, itemId]);

const COLLAB_TITLES = {
  spawnAgent: "Spawn agent",
  sendInput: "Send agent input",
  resumeAgent: "Resume agent",
  wait: "Wait for agents",
  closeAgent: "Close agent",
  sendMessage: "Message agent",
  followupTask: "Assign agent task",
  interruptAgent: "Interrupt agent",
  listAgents: "List agents",
} as const;

const PLAN_STATUS: Record<string, PlanItem["status"]> = {
  pending: "pending",
  inProgress: "inProgress",
  completed: "completed",
};

const FILE_KIND: Record<FileUpdateChange["kind"]["type"], FileChange["kind"]> = {
  add: "add",
  delete: "delete",
  update: "modify",
};

/** A tool item as the tool part Claude's cards expect, or `undefined` for non-tool items. */
export const toolOf = (
  item: ThreadItem,
): { readonly name: string; readonly input: unknown; readonly title?: string } | undefined => {
  switch (item.type) {
    case "collabAgentToolCall":
      return {
        name: "codex_agent",
        title: COLLAB_TITLES[item.tool],
        input: {
          tool: item.tool,
          receiverThreadIds: item.receiverThreadIds,
          ...(item.prompt === null ? {} : { prompt: item.prompt }),
          ...(item.model === null ? {} : { model: item.model }),
          ...(item.reasoningEffort === null ? {} : { reasoningEffort: item.reasoningEffort }),
        },
      };
    case "subAgentActivity":
      return {
        name: "codex_agent_activity",
        title: "Agent activity",
        input: {
          agentThreadId: item.agentThreadId,
          agentPath: item.agentPath,
          activity: item.kind,
        },
      };
    case "commandExecution":
      return {
        name: "Bash",
        input: {
          command: item.commandActions.map((action) => action.command).join("; ") || item.command,
          cwd: item.cwd,
        },
      };
    case "fileChange": {
      const first = item.changes[0];
      if (item.changes.length === 1 && first?.kind.type === "add") {
        return { name: "Write", input: { file_path: first.path, content: first.diff } };
      }
      return {
        name: "Edit",
        input: { ...(first ? { file_path: first.path } : {}), changes: item.changes },
      };
    }
    case "mcpToolCall":
      return { name: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    case "dynamicToolCall":
      return { name: item.tool, input: item.arguments };
    case "webSearch": {
      const action = item.action;
      const itemQuery = item.query ? { query: item.query } : {};
      if (action == null) return { name: "WebSearch", input: itemQuery };
      switch (action.type) {
        case "search":
          return {
            name: "WebSearch",
            title: "Search web",
            input: {
              action: action.type,
              ...(action.query != null ? { query: action.query } : itemQuery),
              ...(action.queries != null ? { queries: action.queries } : {}),
            },
          };
        case "openPage":
          return {
            name: "WebSearch",
            title: "Open page",
            input: { action: action.type, ...(action.url != null ? { url: action.url } : {}) },
          };
        case "findInPage":
          return {
            name: "WebSearch",
            title: "Find in page",
            input: {
              action: action.type,
              ...(action.url != null ? { url: action.url } : {}),
              ...(action.pattern != null ? { pattern: action.pattern } : {}),
            },
          };
        case "other":
          return { name: "WebSearch", title: "Web browsing", input: { action: action.type } };
      }
    }
    case "imageView":
      return { name: "Read", input: { file_path: item.path } };
    default:
      return undefined;
  }
};

/** A file change as `structuredPatch` hunks; an added or deleted file becomes one whole-file hunk. */
export const hunksOf = (change: FileUpdateChange) => patchChangeHunks(change);

/** A finished tool item's output chunk. */
const toolResult = (item: ThreadItem): Chunk | undefined => {
  const available = (output: unknown): Chunk => ({
    type: "tool-output-available",
    toolCallId: item.id,
    output,
    ...TOOL_FLAGS,
  });
  const failed = (errorText: string): Chunk => ({
    type: "tool-output-error",
    toolCallId: item.id,
    errorText,
    ...TOOL_FLAGS,
  });
  switch (item.type) {
    case "collabAgentToolCall":
      if (item.status === "inProgress") return undefined;
      // Completion belongs to the invocation (e.g. spawn), not to the receiving agent's work.
      if (item.status === "interrupted") return failed("Cancelled");
      if (item.status === "failed")
        return failed(`Agent operation failed\n${JSON.stringify(item.agentsStates, null, 2)}`);
      return available({ toolStatus: item.status, lastKnownAgentStates: item.agentsStates });
    case "subAgentActivity":
      return available({
        activity: item.kind,
        agentThreadId: item.agentThreadId,
        agentPath: item.agentPath,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    case "commandExecution":
      if (item.status === "completed") {
        return available({
          stdout: item.aggregatedOutput ?? "",
          stderr: "",
          interrupted: false,
          exitCode: item.exitCode,
        });
      }
      if (item.status === "declined") return failed("Declined");
      if (item.status === "failed") {
        return failed(item.aggregatedOutput?.trim() || `Exit code ${item.exitCode ?? "unknown"}`);
      }
      return undefined;
    case "fileChange":
      if (item.status === "completed") {
        return available({ type: "update", structuredPatch: item.changes.flatMap(hunksOf) });
      }
      if (item.status === "declined") return failed("Declined");
      if (item.status === "failed") return failed("The patch didn't apply");
      return undefined;
    case "mcpToolCall":
      if (item.status === "completed") return available(item.result);
      if (item.status === "failed") return failed(item.error?.message ?? "The tool call failed");
      return undefined;
    case "dynamicToolCall": {
      if (item.success === null) return undefined;
      if (item.success) return available(item.contentItems);
      const errorText = item.contentItems
        ?.filter((content) => content.type === "inputText")
        .map((content) => content.text)
        .join("\n");
      return failed(errorText?.trim() ? errorText : "The tool call failed");
    }
    case "webSearch":
      // A completed item confirms the action, not retrieved page contents. Results are optional
      // opaque provider data; retain them only when Codex actually supplies them.
      return available({
        ...(item.action != null
          ? { action: item.action }
          : item.query
            ? { query: item.query }
            : {}),
        ...(item.results != null ? { results: item.results } : {}),
      });
    case "imageView":
      return available({ type: "image", path: item.path });
    default:
      return undefined;
  }
};

const chunk = (t: Turn, c: Chunk): AgentEvent => ({
  type: "chunk",
  messageId: t.messageId,
  chunk: c,
});

export const makeCodexMapper = (options: CodexMapperOptions): CodexMapper => {
  const gateway = options.gateway === true;
  let turn: Turn | undefined;
  let lastStatus: AgentStatus | undefined;
  let idlePending = false;
  const usageLedger = makeCodexUsageLedger(options.freshSession);
  let contextWindow: number | undefined;
  // Unified exec's item ends on process exit, even after its parent turn ends or is interrupted.
  const commands = new Map<
    string,
    {
      turn: Turn;
      item: Extract<ThreadItem, { type: "commandExecution" }>;
      output: string;
      startedAt: number;
    }
  >();
  const endedTurns = new Set<string>();
  const background = (out: AgentEvent[]) => {
    const tasks: BackgroundTask[] = [...commands.entries()].flatMap(([taskId, command]) =>
      endedTurns.has(command.turn.id)
        ? [
            {
              taskId,
              kind: "shell",
              description: command.item.command,
              command: command.item.command,
              toolCallId: command.item.id,
              startedAt: command.startedAt,
            },
          ]
        : [],
    );
    out.push({ type: "backgroundTasks", tasks });
  };
  /** A `/compact` asked for a compaction that hasn't happened yet. */
  let manualCompaction = false;
  /** The latest request's prompt size (`tokenUsage.last`, cached input included). */
  let contextTokens: number | undefined;
  const fileChanges = new Map<string, ReadonlyArray<FileUpdateChange>>();
  /** Compactions under way, with the context they started from. */
  const compactions = new Map<string, Compaction>();
  const now = options.now ?? Date.now;
  const commandOutput = (command: {
    turn: Turn;
    item: { id: string };
    output: string;
  }): AgentEvent =>
    chunk(command.turn, {
      type: "tool-output-available",
      toolCallId: command.item.id,
      output: { stdout: command.output, stderr: "", interrupted: false },
      preliminary: true,
      ...TOOL_FLAGS,
    });

  const observeCompaction = (
    itemId: string,
    turnId: string,
    activity: Compaction,
    phase: CodexCompactionPhase["phase"],
    providerAt?: number,
  ) => {
    const at = now();
    options.onCompaction?.({
      ...activity,
      itemId,
      turnId,
      phase,
      at,
      elapsedMs: Math.max(0, at - activity.startedAt),
      ...(providerAt !== undefined && Number.isFinite(providerAt)
        ? { providerAt, receivedAfterMs: at - providerAt }
        : {}),
    });
  };

  const status = (s: AgentStatus, detail?: string): Array<AgentEvent> => {
    const compaction = compactions.values().next().value;
    // Thread active/connection status describes the turn, not the end of its compaction item.
    if (s === "running" && compaction !== undefined) s = "compacting";
    if (detail === undefined && s === lastStatus) return [];
    lastStatus = s;
    return [
      {
        type: "status",
        status: s,
        ...(detail === undefined ? {} : { detail }),
        ...(compaction !== undefined && (s === "compacting" || s === "retrying")
          ? { compaction }
          : {}),
      },
    ];
  };

  const ensureTurn = (turnId: string, out: Array<AgentEvent>): Turn => {
    if (turn?.id === turnId) return turn;
    if (turn !== undefined) endTurn(out, "completed");
    const t: Turn = {
      id: turnId,
      messageId: options.newMessageId(),
      parts: new Map(),
      tools: new Set(),
      webInputs: new Map(),
      imagePaths: new Map(),
      pendingTools: new Set(),
      usage: undefined,
      partialUsage: false,
      usageBasis: undefined,
      error: undefined,
      failure: undefined,
    };
    turn = t;
    usageLedger.startTurn();
    out.push(
      chunk(t, {
        type: "start",
        messageId: t.messageId,
        messageMetadata: {
          agent: "codex",
          agentMessageIds: [turnId],
          ...(options.threadId === undefined ? {} : { agentSessionId: options.threadId }),
        },
      }),
      chunk(t, { type: "start-step" }),
    );
    return t;
  };

  const part = (
    t: Turn,
    id: string,
    kind: PartState["kind"],
    out: Array<AgentEvent>,
  ): PartState => {
    let state = t.parts.get(id);
    if (state === undefined) {
      state = { kind, emitted: 0, ended: false };
      t.parts.set(id, state);
      out.push(
        chunk(t, kind === "text" ? { type: "text-start", id } : { type: "reasoning-start", id }),
      );
    }
    return state;
  };

  const delta = (
    t: Turn,
    id: string,
    kind: PartState["kind"],
    text: string,
    out: Array<AgentEvent>,
  ) => {
    const state = part(t, id, kind, out);
    if (state.ended || text === "") return;
    out.push(
      chunk(
        t,
        kind === "text"
          ? { type: "text-delta", id, delta: text }
          : { type: "reasoning-delta", id, delta: text },
      ),
    );
    state.emitted += text.length;
  };

  const endPart = (t: Turn, id: string, out: Array<AgentEvent>) => {
    const state = t.parts.get(id);
    if (state === undefined || state.ended) return;
    state.ended = true;
    out.push(
      chunk(t, state.kind === "text" ? { type: "text-end", id } : { type: "reasoning-end", id }),
    );
  };

  const startTool = (t: Turn, item: ThreadItem, out: Array<AgentEvent>, refreshInput = false) => {
    const tool = toolOf(item);
    if (tool === undefined) return;
    const existing = t.tools.has(item.id);
    if (item.type === "webSearch") {
      // Native web actions can arrive only on item/completed. Refresh the existing part's input
      // and title without opening another tool or resetting its pending/completed lifecycle.
      const input = JSON.stringify(tool);
      if (t.webInputs.get(item.id) === input) return;
      t.webInputs.set(item.id, input);
    } else if (existing && !refreshInput) return;
    if (!existing) {
      t.tools.add(item.id);
      t.pendingTools.add(item.id);
      if (item.type === "imageView") t.imagePaths.set(item.id, item.path);
      out.push(
        chunk(t, {
          type: "tool-input-start",
          toolCallId: item.id,
          toolName: tool.name,
          ...TOOL_FLAGS,
        }),
      );
    }
    out.push(
      chunk(t, {
        type: "tool-input-available",
        toolCallId: item.id,
        toolName: tool.name,
        input: tool.input,
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        ...TOOL_FLAGS,
      }),
    );
    if (item.type === "imageView") {
      out.push({
        type: "toolImageRead",
        origin: "codex-image-view",
        messageId: t.messageId,
        toolCallId: item.id,
        path: item.path,
      });
    }
  };

  /** Sends the part of a finished item's full text that no delta carried. */
  const complete = (
    t: Turn,
    id: string,
    kind: PartState["kind"],
    text: string,
    out: Array<AgentEvent>,
  ) => {
    const emitted = t.parts.get(id)?.emitted ?? 0;
    if (text.length > emitted) delta(t, id, kind, text.slice(emitted), out);
    endPart(t, id, out);
  };

  const endTurn = (
    out: Array<AgentEvent>,
    reason: "completed" | "interrupted" | "failed",
    error?: CodexTurnError | string,
  ) => {
    const t = turn;
    if (t === undefined) return;
    for (const [id, activity] of compactions) {
      // An item with no completion never establishes a successful compaction.
      observeCompaction(id, t.id, activity, reason === "completed" ? "unfinished" : reason);
    }
    compactions.clear();
    manualCompaction = false;
    for (const id of t.pendingTools) {
      const key = commandKey(t.id, id);
      const command = commands.get(key);
      if (command?.item.source === "unifiedExecStartup" && command.item.processId !== null) {
        out.push(commandOutput(command));
        continue;
      }
      commands.delete(key);
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
    for (const id of t.parts.keys()) endPart(t, id, out);
    out.push(chunk(t, { type: "finish-step" }), chunk(t, { type: "finish" }));
    usageLedger.endTurn();
    turn = undefined;
    endedTurns.add(t.id);
    if ([...commands.values()].some((command) => command.turn === t)) background(out);
    if (t.usage !== undefined)
      out.push({
        type: "usage",
        tokens: t.usage,
        ...(t.usageBasis === undefined
          ? {}
          : { telemetryVersion: codexTelemetryVersion(t.usageBasis) }),
        ...(t.partialUsage ? { partial: true } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(contextTokens === undefined ? {} : { contextTokens }),
      });
    const message = (typeof error === "string" ? error : error?.message) ?? t.error;
    const failed =
      t.failure ?? (typeof error === "object" ? codexFailure(error, gateway) : undefined);
    out.push(
      reason === "interrupted"
        ? { type: "turnEnd", reason: "interrupted" }
        : reason === "failed" || message !== undefined
          ? {
              type: "turnEnd",
              reason: "error",
              error: message ?? "The turn failed",
              ...(failed === undefined ? {} : { failure: failed }),
            }
          : { type: "turnEnd", reason: "completed" },
    );
    if (idlePending) {
      idlePending = false;
      out.push(...status("idle"));
    }
  };

  const map = (notification: ServerNotification): Array<AgentEvent> => {
    const out: Array<AgentEvent> = [];
    if (
      options.threadId !== undefined &&
      "threadId" in notification.params &&
      typeof notification.params.threadId === "string" &&
      notification.params.threadId !== options.threadId
    )
      return out;
    switch (notification.method) {
      case "turn/started":
        if (endedTurns.has(notification.params.turn.id)) break;
        ensureTurn(notification.params.turn.id, out);
        idlePending = false;
        out.push(...status("running"));
        break;
      case "model/rerouted": {
        if (turn?.id !== notification.params.turnId) break;
        out.push(
          chunk(turn, {
            type: "message-metadata",
            messageMetadata: {
              model: notification.params.toModel,
              ...(turn.usage !== undefined ? { modelConflict: true } : {}),
            },
          }),
        );
        break;
      }
      case "item/started": {
        const { item, turnId } = notification.params;
        if (
          item.type === "imageView" &&
          ((turn !== undefined && turn.id !== turnId) ||
            (turn?.tools.has(item.id) &&
              (!turn.pendingTools.has(item.id) || turn.imagePaths.get(item.id) !== item.path)))
        )
          break;
        if (endedTurns.has(turnId)) break;
        const t = ensureTurn(turnId, out);
        // A terminal item stays terminal, including when completion arrived before its start.
        if (
          item.type === "commandExecution" &&
          t.tools.has(item.id) &&
          !t.pendingTools.has(item.id)
        )
          break;
        if (item.type === "agentMessage") {
          part(t, item.id, "text", out);
          if (item.text !== "") delta(t, item.id, "text", item.text, out);
        }
        // Reasoning can be silent: its item lifecycle, not optional text, drives the indicator.
        if (item.type === "reasoning") part(t, item.id, "reasoning", out);
        if (item.type === "fileChange") fileChanges.set(item.id, item.changes);
        if (item.type === "contextCompaction") {
          if (compactions.has(item.id)) break;
          const compaction = {
            startedAt: now(),
            trigger: manualCompaction ? ("manual" as const) : ("auto" as const),
            ...(contextTokens === undefined ? {} : { preTokens: contextTokens }),
          };
          compactions.set(item.id, compaction);
          manualCompaction = false;
          observeCompaction(item.id, t.id, compaction, "started", notification.params.startedAtMs);
          lastStatus = "compacting";
          // The item carries nothing but its id: who asked is what this session sent.
          out.push({
            type: "status",
            status: "compacting",
            compaction,
          });
        }
        startTool(t, item, out);
        if (item.type === "commandExecution") {
          const key = commandKey(turnId, item.id);
          if (!commands.has(key))
            commands.set(key, {
              turn: t,
              item,
              output: item.aggregatedOutput ?? "",
              startedAt: now(),
            });
          else if (commands.get(key)!.item.processId === null && item.processId !== null)
            commands.get(key)!.item = item;
        }
        break;
      }
      case "item/commandExecution/outputDelta": {
        const p = notification.params;
        const command = commands.get(commandKey(p.turnId, p.itemId));
        if (command === undefined || p.delta === "") break;
        // Keep a bounded tail while the process runs; the exit item supplies authoritative output.
        command.output = (command.output + p.delta).slice(-64_000);
        out.push(commandOutput(command));
        if (endedTurns.has(p.turnId)) out.push(chunk(command.turn, { type: "finish" }));
        break;
      }
      case "item/commandExecution/terminalInteraction": {
        const p = notification.params;
        const command = commands.get(commandKey(p.turnId, p.itemId));
        if (
          command !== undefined &&
          (command.item.processId === null || command.item.processId === p.processId)
        )
          command.item = { ...command.item, source: "unifiedExecStartup", processId: p.processId };
        break;
      }
      case "item/agentMessage/delta": {
        const p = notification.params;
        if (endedTurns.has(p.turnId)) break;
        delta(ensureTurn(p.turnId, out), p.itemId, "text", p.delta, out);
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const p = notification.params;
        if (endedTurns.has(p.turnId)) break;
        delta(ensureTurn(p.turnId, out), p.itemId, "reasoning", p.delta, out);
        break;
      }
      case "item/reasoning/textDelta": {
        const p = notification.params;
        if (endedTurns.has(p.turnId)) break;
        delta(ensureTurn(p.turnId, out), `${p.itemId}:raw`, "reasoning", p.delta, out);
        break;
      }
      case "item/completed": {
        const { item, turnId } = notification.params;
        if (
          item.type === "imageView" &&
          ((turn !== undefined && turn.id !== turnId) ||
            (turn?.tools.has(item.id) &&
              (!turn.pendingTools.has(item.id) || turn.imagePaths.get(item.id) !== item.path)))
        )
          break;
        const key = commandKey(turnId, item.id);
        const command = item.type === "commandExecution" ? commands.get(key) : undefined;
        const completedItem =
          item.type === "commandExecution" &&
          item.aggregatedOutput === null &&
          command !== undefined
            ? { ...item, aggregatedOutput: command.output }
            : item;
        if (endedTurns.has(turnId)) {
          // A late exit updates only the known command in its original message. Never open a
          // stale turn (or turn an unknown/replayed item into another tool row).
          if (command === undefined) break;
          if (item.type === "commandExecution" && item.processId !== command.item.processId) break;
          const result = toolResult(completedItem);
          if (result === undefined) break;
          commands.delete(key);
          command.turn.pendingTools.delete(item.id);
          out.push(chunk(command.turn, result), chunk(command.turn, { type: "finish" }));
          background(out);
          break;
        }
        const t = ensureTurn(turnId, out);
        if (
          item.type === "commandExecution" &&
          t.tools.has(item.id) &&
          !t.pendingTools.has(item.id)
        )
          break;
        if (item.type === "agentMessage") complete(t, item.id, "text", item.text, out);
        if (item.type === "contextCompaction") {
          // The item says no more than that it happened. The summarizing request reports usage of
          // its own on the way, so the context it compacted is the reading from before it started;
          // the context after isn't reported (the next `last` is a zero).
          const activity = compactions.get(item.id);
          const preTokens = activity?.preTokens;
          if (activity !== undefined)
            observeCompaction(
              item.id,
              t.id,
              activity,
              "completed",
              notification.params.completedAtMs,
            );
          compactions.delete(item.id);
          const trigger = activity?.trigger ?? (manualCompaction ? "manual" : "auto");
          manualCompaction = false;
          out.push(
            chunk(t, {
              type: "data-compaction",
              id: `compaction:${item.id}`,
              data: {
                trigger,
                ...(preTokens === undefined ? {} : { preTokens }),
                at: now(),
              },
            }),
          );
          out.push(...status("running"));
        }
        if (item.type === "reasoning") {
          complete(t, item.id, "reasoning", item.summary.join("\n\n"), out);
          endPart(t, `${item.id}:raw`, out);
          // Completion-only/reordered items stay terminal without inventing a streaming part.
          for (const id of [item.id, `${item.id}:raw`]) {
            if (!t.parts.has(id)) t.parts.set(id, { kind: "reasoning", emitted: 0, ended: true });
          }
        }
        const result = toolResult(completedItem);
        if (result !== undefined) {
          // The final patch can supply paths/operations absent from item/started. Refresh only
          // its input/name, keeping the original call and approval-time patches intact.
          startTool(
            t,
            item,
            out,
            (item.type === "fileChange" && item.changes.length > 0) ||
              item.type === "collabAgentToolCall",
          );
          if (item.type === "imageView") {
            out.push({
              type: "toolImageSource",
              origin: "codex-image-view",
              messageId: t.messageId,
              toolCallId: item.id,
              path: item.path,
            });
          }
          if (
            result.type === "tool-output-available" &&
            (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
          ) {
            const extracted = splitToolImageOutput(result.output);
            out.push(
              ...extracted.images.map((image): AgentEvent => ({
                type: "toolImage",
                messageId: t.messageId,
                toolCallId: item.id,
                ...image,
              })),
            );
            result.output = extracted.output;
          }
          t.pendingTools.delete(item.id);
          commands.delete(key);
          out.push(chunk(t, result));
        }
        if (item.type === "fileChange" && item.status === "completed" && item.changes.length > 0) {
          out.push({
            type: "files",
            changes: item.changes.map((change) => ({
              path: change.path,
              kind: FILE_KIND[change.kind.type],
            })),
          });
        }
        break;
      }
      case "turn/plan/updated":
        out.push({
          type: "plan",
          items: notification.params.plan.map((step) => ({
            content: step.step,
            status: PLAN_STATUS[step.status] ?? "pending",
          })),
        });
        break;
      case "thread/goal/updated":
        out.push({ type: "goal", objective: notification.params.goal.objective });
        break;
      case "thread/goal/cleared":
        out.push({ type: "goal" });
        break;
      case "thread/tokenUsage/updated": {
        // An ended native turn cannot seed a later turn from a delayed/replayed report.
        if (endedTurns.has(notification.params.turnId)) break;
        if (turn !== undefined && turn.id !== notification.params.turnId) break;
        const telemetry = notification.params.tokenUsage;
        const total = codexCounts(telemetry.total),
          last = codexCounts(telemetry.last);
        const report = usageLedger.observe(total, last);
        contextTokens = last?.inputTokens;
        if (turn !== undefined) {
          turn.partialUsage ||= report.partial;
          const detailConflict = usageLedger.detailConflict();
          if (detailConflict && turn.usage !== undefined)
            turn.usage = {
              inputTokens: turn.usage.inputTokens,
              outputTokens: turn.usage.outputTokens,
            };
          if (report.tokens !== undefined || (detailConflict && turn.usage !== undefined)) {
            const next =
              report.tokens === undefined
                ? turn.usage!
                : turn.usage === undefined
                  ? report.tokens
                  : addCodexCounts(turn.usage, report.tokens);
            if (validCodexCounts(next)) {
              turn.usage = next;
              turn.usageBasis =
                turn.usageBasis === "last-request" || report.basis === "last-request"
                  ? "last-request"
                  : "delta";
            } else turn.partialUsage = true;
            if (turn.usage === undefined) break;
            out.push({
              type: "usage",
              tokens: turn.usage,
              ...(turn.usageBasis === undefined
                ? {}
                : { telemetryVersion: codexTelemetryVersion(turn.usageBasis) }),
              ...(turn.partialUsage ? { partial: true } : {}),
              ...(contextTokens === undefined ? {} : { contextTokens }),
              ...(telemetry.modelContextWindow === null
                ? {}
                : { contextWindow: telemetry.modelContextWindow }),
            });
          }
        }
        if (notification.params.tokenUsage.modelContextWindow !== null) {
          contextWindow = notification.params.tokenUsage.modelContextWindow;
        }
        break;
      }
      case "thread/status/changed": {
        const s = notification.params.status;
        if (s.type === "idle") {
          if (turn === undefined) out.push(...status("idle"));
          else idlePending = true;
        } else if (s.type === "active") {
          out.push(
            ...status(
              s.activeFlags.includes("waitingOnApproval") && options.answersApprovals?.() !== true
                ? "awaitingApproval"
                : s.activeFlags.includes("waitingOnUserInput")
                  ? "awaitingInput"
                  : "running",
            ),
          );
        } else if (s.type === "systemError") {
          out.push(...status("error"));
        }
        break;
      }
      case "turn/completed": {
        // A compaction asked for and interrupted never happened; the next one is Codex's own.
        manualCompaction = false;
        const t = notification.params.turn;
        if (turn?.id !== t.id) break;
        endTurn(
          out,
          t.status === "interrupted"
            ? "interrupted"
            : t.status === "failed"
              ? "failed"
              : "completed",
          t.error ?? undefined,
        );
        break;
      }
      case "error": {
        const p = notification.params;
        if (p.willRetry) {
          // Codex's own words ("Reconnecting... 1/2") with the status its error carries, the way
          // Claude's adapter writes a retry, so the runtime can log the attempt and status.
          const { httpStatus } = codexFailure(p.error, gateway);
          const suffix = httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`;
          out.push(...status("retrying", `${p.error.message}${suffix}`));
        } else {
          const failed = codexFailure(p.error, gateway);
          if (turn !== undefined) {
            turn.error = p.error.message;
            turn.failure = failed;
          }
          // A limit is waited out on the thread itself, so it raises no error notice of its own.
          if (failed.kind !== "rateLimit") {
            out.push({ type: "notice", level: "error", message: p.error.message });
          }
        }
        break;
      }
      case "serverRequest/resolved":
        out.push({
          type: "requestResolved",
          requestId: RequestId.make(`codex-${notification.params.requestId}`),
        });
        break;
      case "configWarning": {
        const p = notification.params;
        out.push({
          type: "notice",
          level: "warning",
          message: (p as { message?: string }).message ?? p.summary ?? "Codex warning",
          ...(options.diagnosticScope === undefined
            ? {}
            : {
                startupDiagnostic: startupDiagnostic(
                  options.diagnosticScope,
                  "Codex configuration",
                  [p.path ?? options.diagnosticCwd, p.summary, p.details],
                ),
              }),
        });
        break;
      }
      case "warning": {
        const p = notification.params;
        // Generic warnings can concern a turn. Only the explicit threadless MCP startup form groups.
        const mcp =
          p.threadId === null || p.threadId === undefined
            ? /^MCP (?:client for|server) [`'"]?([^`'": ]+)[`'"]? (?:failed to start|didn't start)/i.exec(
                p.message,
              )
            : null;
        out.push({
          type: "notice",
          level: "warning",
          message: p.message ?? (p as { summary?: string }).summary ?? "Codex warning",
          ...(mcp && options.diagnosticScope !== undefined
            ? {
                startupDiagnostic: startupDiagnostic(options.diagnosticScope, "Codex MCP startup", [
                  mcp[1],
                  p.message,
                ]),
              }
            : {}),
        });
        break;
      }
      case "mcpServer/startupStatus/updated": {
        const p = notification.params;
        if (p.status === "failed") {
          out.push({
            type: "notice",
            level: "warning",
            message: `MCP server ${p.name} didn't start${p.error ? `: ${p.error}` : ""}`,
            ...(options.diagnosticScope === undefined
              ? {}
              : {
                  startupDiagnostic: startupDiagnostic(
                    options.diagnosticScope,
                    "Codex MCP startup",
                    [
                      p.threadId == null ? "server" : options.diagnosticCwd,
                      p.name,
                      p.error,
                      p.failureReason,
                    ],
                  ),
                }),
          });
        }
        break;
      }
      case "account/rateLimits/updated":
        out.push(...codexRateLimits(notification.params.rateLimits));
        break;
      // A client's own records on the thread, made only by `thread/attachment/add`, never sent here.
      case "thread/attachment/updated":
      // Sign-in for a model provider that authenticates by OAuth; Gram's providers take a key.
      case "account/gatewayOAuth/changed":
      default:
        break;
    }
    return out;
  };

  return {
    map,
    changes: (itemId) => fileChanges.get(itemId),
    awaitingApproval: () => status("awaitingApproval"),
    compactionRequested: (pending) => {
      manualCompaction = pending;
    },
    flush: () => {
      const out: Array<AgentEvent> = [];
      for (const command of commands.values()) {
        if (!endedTurns.has(command.turn.id)) continue;
        out.push(
          chunk(command.turn, {
            type: "tool-output-error",
            toolCallId: command.item.id,
            errorText: "Codex stopped before the process exited",
            ...TOOL_FLAGS,
          }),
          chunk(command.turn, { type: "finish" }),
        );
      }
      const hadBackground = [...commands.values()].some((command) =>
        endedTurns.has(command.turn.id),
      );
      commands.clear();
      if (hadBackground) background(out);
      endTurn(out, "failed", "Codex stopped before the turn finished");
      return out;
    },
  };
};

import type { InferUIMessageChunk, UIMessage } from "ai";
import * as Schema from "effect/Schema";
import type { ThreadError } from "./agent-failure.ts";
import type { BabysitReport, HumanReviewNotice, ReviewNotice } from "./babysit.ts";
import {
  AgentKind,
  InputAuthor,
  type IdleCompactNotice,
  PlanItem,
  SubagentUsage,
  UsageSummary,
} from "./domain.ts";
import type { DreamReport } from "./dreams.ts";
import { TaskId, TurnId, WorkspaceId } from "./ids.ts";
import type {
  Handoff,
  MemoryWrite,
  MessageOrigin,
  OrchestrationDigest,
  WorkerAnswer,
  WorkerReport,
} from "./orchestration.ts";
import type { WaitData, WaitNoteData } from "./waits.ts";
import type { WorkerQuestion } from "./worker-questions.ts";
import type { MockCardData } from "./mock-visuals.ts";
import type { WrapUpData } from "./wrap-up.ts";

// ---------------------------------------------------------------------------------------------
// Metadata and data parts

export const MessageMetadataSchema = Schema.Struct({
  turnId: Schema.optionalKey(TurnId),
  /** Epoch ms. */
  createdAt: Schema.optionalKey(Schema.Number),
  agent: Schema.optionalKey(AgentKind),
  /** Actual provider session scope captured with this message, never the current thread alias. */
  agentSessionId: Schema.optionalKey(Schema.String),
  /**
   * The model that produced this message, as the agent names it on the wire
   * (`claude-opus-5-20260401`), not the alias a caller may have asked for (`opus`). On a subagent
   * transcript it is that lane's own model, which is how an inherited default becomes visible:
   * `TaskInput.model` is set only when the spawning call passed an explicit override.
   */
  model: Schema.optionalKey(Schema.String),
  /** More than one actual wire model occurred in this MAIN turn; a single model cannot represent it. */
  modelConflict: Schema.optionalKey(Schema.Boolean),
  usage: Schema.optionalKey(UsageSummary),
  /** Set on subagent transcript messages nested under a Task tool card. */
  parentToolUseId: Schema.optionalKey(Schema.String),
  /**
   * `agent` on a reply the agent started on its own rather than in answer to a send, e.g. after a
   * background subagent reported back. Only such a reply opens a turn on an idle thread.
   */
  initiator: Schema.optionalKey(Schema.Literal("agent")),
  /**
   * The agent-native message ids (Claude SDK `uuid`s) this UIMessage covers, in order. The last one
   * is the resume point for "rewind to after this message".
   */
  agentMessageIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * On a user-role message, who wrote it (`UserInput.author`): `user` only for what the user typed,
   * `server` for Gram's notices. Absent where the server established neither.
   */
  author: Schema.optionalKey(InputAuthor),
});
export type MessageMetadata = typeof MessageMetadataSchema.Type;

export const PlanDataSchema = Schema.Struct({ items: Schema.Array(PlanItem) });
export type PlanData = typeof PlanDataSchema.Type;

export const UsageDataSchema = UsageSummary;
export type UsageData = typeof UsageDataSchema.Type;

export const SubagentUsageDataSchema = SubagentUsage;
export type SubagentUsageData = typeof SubagentUsageDataSchema.Type;

export const CheckpointDataSchema = Schema.Struct({
  turnId: TurnId,
  /** `refs/gram/checkpoints/<thread>/<turn>`. Informational: a restore names the ref from its thread and turn. */
  ref: Schema.String,
  /** Epoch ms. */
  createdAt: Schema.Number,
});
export type CheckpointData = typeof CheckpointDataSchema.Type;

/** A transcript divider from the `mark_chapter` app tool. */
export const ChapterDataSchema = Schema.Struct({ id: Schema.String, title: Schema.String });
export type ChapterData = typeof ChapterDataSchema.Type;

/** A follow-up offered by the `spawn_task` app tool; accepting it opens a new thread. */
export const TaskChipDataSchema = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  prompt: Schema.String,
  /**
   * Where the new thread starts. A worktree of its own unless this is `current`, which shares the
   * offering thread's checkout: right only for a task that must see its uncommitted files and
   * writes nothing, since two agents in one working tree share one HEAD and one index.
   */
  checkout: Schema.optionalKey(Schema.Literals(["current", "new-worktree"])),
  branch: Schema.optionalKey(Schema.String),
  /** What the new worktree branches from; the offering thread's HEAD when absent. */
  base: Schema.optionalKey(Schema.String),
  /** Why an orchestrator offered this rather than starting a worker, which it has to say. */
  reason: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["offered", "accepted", "dismissed"]),
});
export type TaskChipData = typeof TaskChipDataSchema.Type;

/**
 * A drawing from the `show_widget` app tool: one SVG document. The transcript shows it through
 * `<img>`, where an SVG is a static image, so its scripts never run and it can load nothing.
 */
export const WidgetDataSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  svg: Schema.String,
});
export type WidgetData = typeof WidgetDataSchema.Type;

/**
 * An image a tool call returned (a `Read` of a PNG, a screenshot from an MCP tool), stored by the
 * server under the thread's attachments and served back by `attachment.read`. `path` is absent when
 * nothing was stored: the image was over the preview limit or not a type the preview can show.
 */
export const ToolImageDataSchema = Schema.Struct({
  toolCallId: Schema.String,
  mediaType: Schema.String,
  /** Decoded bytes. */
  size: Schema.Int,
  path: Schema.optionalKey(Schema.String),
});
export type ToolImageData = typeof ToolImageDataSchema.Type;

/**
 * Marks where the agent compacted the conversation: replaced what came before with a summary of it,
 * to make room in its context window.
 */
export const CompactionDataSchema = Schema.Struct({
  /** `manual` when the user asked for it (`/compact`), `auto` when the agent did it to make room. */
  trigger: Schema.Literals(["manual", "auto"]),
  /** The context it compacted, in tokens; absent when the agent doesn't say. */
  preTokens: Schema.optionalKey(Schema.Int),
  /** The context left after it; absent when the agent doesn't say. */
  postTokens: Schema.optionalKey(Schema.Int),
  /** Epoch ms. Absent leaves the marker without a time. */
  at: Schema.optionalKey(Schema.Number),
  /** What the agent carries on from instead of the conversation, when it shares it (Claude). */
  summary: Schema.optionalKey(Schema.String),
  /**
   * `idle` when Gram compacted an idle thread before its prompt cache expired, rather than the user
   * or the agent asking; absent otherwise.
   */
  reason: Schema.optionalKey(Schema.Literal("idle")),
  /**
   * How a compaction Gram started ended: `completed` when the agent reported its boundary, `failed`
   * when the turn failed, `unknown` when it ended without saying. Absent on the agent's own.
   */
  outcome: Schema.optionalKey(Schema.Literals(["completed", "failed", "unknown"])),
  /** The workspace whose idle compaction setting started it, for the marker's link to it. */
  workspaceId: Schema.optionalKey(WorkspaceId),
});
export type CompactionData = typeof CompactionDataSchema.Type;

/** Why Gram restarts a session on its own; a stored literal, so one is never removed. */
export const SessionRestartReason = Schema.Literals(["mcpConfig"]);
export type SessionRestartReason = typeof SessionRestartReason.Type;

/**
 * Marks where the thread's agent session was restarted to read its setup from disk again (settings,
 * MCP servers and connectors, instructions, skills, the CLI), carrying on the same conversation.
 */
export const SessionRestartDataSchema = Schema.Struct({
  /** Epoch ms the new session opened. */
  at: Schema.Number,
  /**
   * Why it restarted when Gram did it on its own: `mcpConfig`, an MCP server or connector the
   * thread's agent uses changed. Absent when someone asked for it.
   */
  reason: Schema.optionalKey(SessionRestartReason),
});
export type SessionRestartData = typeof SessionRestartDataSchema.Type;

export type DataParts = {
  plan: PlanData;
  usage: UsageData;
  /** One per subagent run, id'd by its tool call id so each snapshot replaces the one before it. */
  "subagent-usage": SubagentUsageData;
  checkpoint: CheckpointData;
  chapter: ChapterData;
  "task-chip": TaskChipData;
  /** Where `wait_on_user` added an item to Waiting on you, restyled as it is resolved. */
  wait: WaitData;
  /** On a user message: what Gram told the agent about Waiting on you with it. */
  "wait-note": WaitNoteData;
  widget: WidgetData;
  /** Id'd by tool call and content, so an image reported twice is one part. */
  "tool-image": ToolImageData;
  compaction: CompactionData;
  "session-restart": SessionRestartData;
  /** At the end of a turn that failed: what went wrong, in the transcript where it happened. */
  "agent-error": ThreadError;
  /** On a user message queued by the review monitor. */
  "review-notice": ReviewNotice;
  /** On a user message queued by the review monitor for a person's review. */
  "human-review-notice": HumanReviewNotice;
  "babysit-report": BabysitReport;
  /** On a user message another thread sent. */
  "thread-origin": MessageOrigin;
  /** On the server-authored user message that wakes an orchestrator. */
  "orchestration-digest": OrchestrationDigest;
  /** On the server-authored `/compact` idle compaction sends, in place of the user's bubble. */
  "idle-compact": IdleCompactNotice;
  /** In a worker's transcript, where it called `report`. */
  "worker-report": WorkerReport;
  /** In an orchestrator's transcript, where it changed its memory. */
  "memory-write": MemoryWrite;
  /** Marks where an orchestrator's agent session was replaced by a fresh one. */
  handoff: Handoff;
  /** In a worker's transcript and its orchestrator's, where the orchestrator answered its question. */
  "worker-answer": WorkerAnswer;
  /**
   * A worker's own question (`ask_question`), id'd by the question so each change (forwarded,
   * answered, dismissed) replaces the card in place: in the worker's transcript, and in its
   * orchestrator's where the orchestrator answered or forwarded it.
   */
  "worker-question": WorkerQuestion;
  /** Where the agent called `show_mock`: the mock's title, version, direction shots and Open in Preview. */
  mock: MockCardData;
  /** In a dream's own thread, where it ended: what the review will show, in short. */
  "dream-report": DreamReport;
  /** Where the agent called `wrap_up`; the card under the transcript shows it, not the message. */
  "wrap-up": WrapUpData;
};

// ---------------------------------------------------------------------------------------------
// Claude built-in tools (Agent SDK 0.3.272 `sdk-tools.d.ts`, trimmed to what the UI renders)

export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface BashInput {
  command: string;
  timeout?: number;
  description?: string;
  run_in_background?: boolean;
  dangerouslyDisableSandbox?: boolean;
}
export interface BashOutput {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  rawOutputPath?: string;
  isImage?: boolean;
  noOutputExpected?: boolean;
  backgroundTaskId?: string;
}

export interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
  pages?: string;
}
export type ReadOutput =
  | {
      type: "text";
      file: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
      };
    }
  | { type: "image" | "notebook" | "pdf" | "parts" | "file_unchanged"; file?: unknown };

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}
export interface EditOutput {
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string | null;
  structuredPatch: StructuredPatchHunk[];
  userModified: boolean;
}

export interface WriteInput {
  file_path: string;
  content: string;
}
export interface WriteOutput {
  type: "create" | "update";
  filePath: string;
  content: string;
  structuredPatch: StructuredPatchHunk[];
  originalFile: string | null;
}

export interface GlobInput {
  pattern: string;
  path?: string;
}
export interface GlobOutput {
  durationMs: number;
  numFiles: number;
  filenames: string[];
  truncated: boolean;
}

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  output_mode?: "content" | "files_with_matches" | "count";
  "-A"?: number;
  "-B"?: number;
  "-C"?: number;
  "-i"?: boolean;
  "-n"?: boolean;
  type?: string;
  head_limit?: number;
  multiline?: boolean;
}
export interface GrepOutput {
  mode?: "content" | "files_with_matches" | "count";
  numFiles: number;
  filenames: string[];
  content?: string;
  numLines?: number;
  numMatches?: number;
}

/** Claude Code's subagent tool; newer CLIs name it `Agent`. */
export interface TaskInput {
  description: string;
  prompt: string;
  subagent_type?: string;
  /**
   * An explicit override the caller asked for, as an alias (`opus`); absent when the subagent
   * inherits the thread's model. The model it actually ran on is `MessageMetadata.model` on its
   * transcript, a wire id — the two are not reconciled into one display name.
   */
  model?: string;
  run_in_background?: boolean;
  name?: string;
  isolation?: "worktree" | "remote";
}
export type TaskOutput =
  | {
      status: "completed";
      agentId: string;
      agentType?: string;
      content: { type: "text"; text: string }[];
      prompt: string;
      totalToolUseCount: number;
      totalDurationMs: number;
      totalTokens: number;
    }
  | {
      status: "async_launched";
      agentId: string;
      description: string;
      prompt: string;
      outputFile: string;
    };

export interface WebFetchInput {
  url: string;
  prompt: string;
}
export interface WebFetchOutput {
  bytes: number;
  code: number;
  codeText: string;
  result: string;
  durationMs: number;
  url: string;
}

export interface WebSearchInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}
export interface WebSearchOutput {
  query: string;
  results: ({ tool_use_id: string; content: { title: string; url: string }[] } | string)[];
  durationSeconds: number;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}
export interface TodoWriteInput {
  todos: TodoItem[];
}
export interface TodoWriteOutput {
  oldTodos: TodoItem[];
  newTodos: TodoItem[];
}

/**
 * A subagent's tool result arrives as plain text: the Claude Code SDK sends no `tool_use_result`
 * on a sidechain message, so the Claude mapper falls back to the result text. Each declared output
 * is what the main lane sends, and `string` is what a subagent sends instead.
 */
type WithResultText<T extends Record<string, { input: unknown; output: unknown }>> = {
  [K in keyof T]: { input: T[K]["input"]; output: T[K]["output"] | string };
};

export type ClaudeTools = WithResultText<{
  Bash: { input: BashInput; output: BashOutput };
  Read: { input: ReadInput; output: ReadOutput };
  Edit: { input: EditInput; output: EditOutput };
  Write: { input: WriteInput; output: WriteOutput };
  Glob: { input: GlobInput; output: GlobOutput };
  Grep: { input: GrepInput; output: GrepOutput };
  Task: { input: TaskInput; output: TaskOutput };
  Agent: { input: TaskInput; output: TaskOutput };
  WebFetch: { input: WebFetchInput; output: WebFetchOutput };
  WebSearch: { input: WebSearchInput; output: WebSearchOutput };
  TodoWrite: { input: TodoWriteInput; output: TodoWriteOutput };
}>;

// ---------------------------------------------------------------------------------------------
// Messages and chunks

export type GramUIMessage = UIMessage<MessageMetadata, DataParts, ClaudeTools>;
export type GramUIMessageChunk = InferUIMessageChunk<GramUIMessage>;

const isRecord = (u: unknown): u is Record<string, unknown> =>
  typeof u === "object" && u !== null && !Array.isArray(u);

/**
 * A `UIMessageChunk` passed through as-is. Only the `type` discriminator is checked; the AI SDK
 * owns the chunk grammar and `readUIMessageStream` rejects malformed chunks on the client.
 */
export const UIMessageChunkSchema = Schema.declare(
  (u: unknown): u is GramUIMessageChunk => isRecord(u) && typeof u["type"] === "string",
  { identifier: "UIMessageChunk" },
);

/**
 * A stored `UIMessage` passed through with a shallow shape check. Deep validation happens with
 * `safeValidateUIMessages` when messages are loaded from the database.
 */
export const UIMessageSchema = Schema.declare(
  (u: unknown): u is GramUIMessage =>
    isRecord(u) &&
    typeof u["id"] === "string" &&
    (u["role"] === "system" || u["role"] === "user" || u["role"] === "assistant") &&
    Array.isArray(u["parts"]),
  { identifier: "UIMessage" },
);

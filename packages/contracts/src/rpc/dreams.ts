import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { ModelRef } from "../domain.ts";
import {
  DREAM_INSTRUCTIONS_MAX,
  AutomaticDreamStatus,
  Dream,
  DreamBudgetTokens,
  DreamAgentSession,
  DreamId,
  DreamKind,
  DreamMode,
  DreamMerge,
  DreamResolution,
  DreamReview,
  ImportPreview,
  MemoryFileInfo,
  MemoryVersionInfo,
} from "../dreams.ts";
import { AgentUnavailable, FsError, InvalidState, NotFound, ThreadNotFound } from "../errors.ts";
import { ProjectId, ThreadId, WorkspaceId } from "../ids.ts";
import { MemoryWrite } from "../orchestration.ts";
import { AnswerQuestionInput, AnswerQuestionResult } from "../questions.ts";
import { PositiveInt, errors } from "./shared.ts";

/**
 * Dreams and history import, and a workspace's memory and its open questions.
 */
export const DreamRpcs = RpcGroup.make(
  Rpc.make("dream.automaticStatus", {
    payload: { workspaceId: WorkspaceId },
    success: AutomaticDreamStatus,
    error: errors(NotFound),
  }),
  /**
   * What an import or a dream would read, counted before anything runs. An import (the default
   * `kind`) counts the agents' own sessions per project, agent and folder (worktrees included),
   * newest `perRepo` (default 30) each; `includeMemory` also counts Claude Code's memory files for
   * those folders. A `dream` counts what is past the watermarks as `dream`, within `budgetTokens`.
   */
  Rpc.make("dream.preview", {
    payload: {
      workspaceId: WorkspaceId,
      kind: Schema.optionalKey(DreamKind),
      budgetTokens: Schema.optionalKey(DreamBudgetTokens),
      projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
      perRepo: Schema.optionalKey(PositiveInt),
      includeMemory: Schema.optionalKey(Schema.Boolean),
    },
    success: ImportPreview,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Starts a dream as a visible thread; one runs per workspace at a time. With no `threadIds` and
   * no `agentSessions`, a `dream` reads the workspace's Gram threads and archive, and an
   * `import` what `dream.preview` found for `projectIds` and `perRepo`.
   */
  Rpc.make("dream.start", {
    payload: {
      workspaceId: WorkspaceId,
      kind: DreamKind,
      mode: Schema.optionalKey(DreamMode),
      threadIds: Schema.optionalKey(Schema.Array(ThreadId)),
      agentSessions: Schema.optionalKey(Schema.Array(DreamAgentSession)),
      instructions: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(DREAM_INSTRUCTIONS_MAX)),
      ),
      model: Schema.optionalKey(ModelRef),
      projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
      perRepo: Schema.optionalKey(PositiveInt),
      /** Copies Claude Code's memory files for the workspace's folders in as seed material. */
      includeMemory: Schema.optionalKey(Schema.Boolean),
      /** How much a `dream` reads, `DREAM_BUDGET_TOKENS_DEFAULT` when absent; the rest waits. */
      budgetTokens: Schema.optionalKey(DreamBudgetTokens),
    },
    success: Dream,
    error: errors(NotFound, InvalidState, FsError, AgentUnavailable),
  }),
  /** Newest first. */
  Rpc.make("dream.list", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(Dream),
    error: errors(NotFound, InvalidState),
  }),
  /** The output against the memory the dream started from, with live writes since as conflicts. */
  Rpc.make("dream.review", {
    payload: { dreamId: DreamId },
    success: DreamReview,
    error: errors(NotFound, InvalidState, FsError),
  }),
  /** Stops a running dream. Its partial output stays for inspection and can only be discarded. */
  Rpc.make("dream.cancel", {
    payload: { dreamId: DreamId },
    success: Dream,
    error: errors(NotFound, InvalidState),
  }),
  /**
   * Starts a model's merge of one `conflict` of a completed dream's review, on the dream's own
   * agent and model, confined as the dream was. It runs on the server; `dreams.changed` says when it
   * ends, and `dream.review` carries it as the file's `merge`. Asking again starts it over.
   */
  Rpc.make("dream.merge", {
    payload: { dreamId: DreamId, path: Schema.String },
    success: DreamMerge,
    error: errors(NotFound, InvalidState, FsError),
  }),
  /**
   * The user's alone: no agent tool reaches it. Every `conflict` of the review needs a side in
   * `resolutions`, and an adoption or restore since the dream started is refused: review again.
   * `merged` is refused for a file with no finished merge of the sides the review holds now.
   */
  Rpc.make("dream.adopt", {
    payload: {
      dreamId: DreamId,
      resolutions: Schema.optionalKey(Schema.Record(Schema.String, DreamResolution)),
      /** `DreamReview.memoryVersion` as the user saw it; a different one now means review again. */
      basedOn: Schema.optionalKey(Schema.String),
      /** `DreamReview.outputDigest` as the user saw it; a different one now means review again. */
      outputDigest: Schema.optionalKey(Schema.String),
      memoryDigest: Schema.optionalKey(Schema.String),
    },
    success: Dream,
    error: errors(NotFound, InvalidState, FsError),
  }),
  /** Deletes the dream's folder, manifest and row. Refused while it runs: cancel first. */
  Rpc.make("dream.discard", {
    payload: { dreamId: DreamId },
    error: errors(NotFound, InvalidState, FsError),
  }),
  // The user's own door to a workspace's memory: the same confinement,
  // caps and scrubbing as the orchestrator's tools, and open while orchestration is paused.
  Rpc.make("memory.list", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(MemoryFileInfo),
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("memory.read", {
    payload: { workspaceId: WorkspaceId, path: Schema.String },
    success: Schema.Struct({ path: Schema.String, content: Schema.String }),
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("memory.write", {
    payload: { workspaceId: WorkspaceId, path: Schema.String, content: Schema.String },
    success: MemoryWrite,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("memory.delete", {
    payload: { workspaceId: WorkspaceId, path: Schema.String },
    success: MemoryWrite,
    error: errors(NotFound, InvalidState, FsError),
  }),
  /** The kept versions, oldest first. */
  Rpc.make("memory.versions", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(MemoryVersionInfo),
    error: errors(NotFound, InvalidState, FsError),
  }),
  /** Points memory back at a kept version; nothing is copied or deleted. */
  Rpc.make("memory.restore", {
    payload: { workspaceId: WorkspaceId, version: Schema.String },
    error: errors(NotFound, InvalidState, FsError),
  }),
  /**
   * The user's answer to an open question in `questions.md`: closes its
   * entry as answered, then sends the answer to the orchestrator, steered while it runs.
   * `InvalidState`: the entry is closed already or gone, or the workspace has no orchestrator.
   */
  Rpc.make("question.answer", {
    payload: AnswerQuestionInput,
    success: AnswerQuestionResult,
    error: errors(NotFound, InvalidState, FsError, ThreadNotFound, AgentUnavailable),
  }),
);

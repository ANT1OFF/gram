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
  Rpc.make("dream.list", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(Dream),
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("dream.review", {
    payload: { dreamId: DreamId },
    success: DreamReview,
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("dream.cancel", {
    payload: { dreamId: DreamId },
    success: Dream,
    error: errors(NotFound, InvalidState),
  }),
  Rpc.make("dream.merge", {
    payload: { dreamId: DreamId, path: Schema.String },
    success: DreamMerge,
    error: errors(NotFound, InvalidState, FsError),
  }),
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
  Rpc.make("dream.discard", {
    payload: { dreamId: DreamId },
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("memory.list", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(MemoryFileInfo),
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("memory.read", {
    payload: { workspaceId: WorkspaceId, path: Schema.String },
    success: Schema.Struct({
      path: Schema.String,
      content: Schema.String,
      keptFromWorkers: Schema.optionalKey(Schema.String),
    }),
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
  Rpc.make("memory.versions", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(MemoryVersionInfo),
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("memory.restore", {
    payload: { workspaceId: WorkspaceId, version: Schema.String },
    error: errors(NotFound, InvalidState, FsError),
  }),
  Rpc.make("question.answer", {
    payload: AnswerQuestionInput,
    success: AnswerQuestionResult,
    error: errors(NotFound, InvalidState, FsError, ThreadNotFound, AgentUnavailable),
  }),
);

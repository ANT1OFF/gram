import { run, type RpcContext } from "../rpc-client";
import type { DreamPreviewInput } from "../types";
import type { DreamsApi } from "./types";

/** The optional fields `dream.preview` and `dream.start` share, without `undefined` values. */
const dreamScope = ({ projectIds, perRepo, includeMemory, budgetTokens }: DreamPreviewInput) => ({
  ...(projectIds === undefined ? {} : { projectIds: [...projectIds] }),
  ...(perRepo === undefined ? {} : { perRepo }),
  ...(includeMemory === undefined ? {} : { includeMemory }),
  ...(budgetTokens === undefined ? {} : { budgetTokens }),
});

/** `DreamsApi` over the RPC client. */
export const dreamsRpc = ({ client }: RpcContext): DreamsApi => ({
  automaticDreamStatus: (workspaceId) => run(client["dream.automaticStatus"]({ workspaceId })),
  listMemory: (workspaceId) => run(client["memory.list"]({ workspaceId })),
  readMemory: (workspaceId, path) => run(client["memory.read"]({ workspaceId, path })),
  writeMemory: (workspaceId, path, content) =>
    run(client["memory.write"]({ workspaceId, path, content })),
  deleteMemory: (workspaceId, path) => run(client["memory.delete"]({ workspaceId, path })),
  listMemoryVersions: (workspaceId) => run(client["memory.versions"]({ workspaceId })),
  restoreMemory: (workspaceId, version) => run(client["memory.restore"]({ workspaceId, version })),
  answerQuestion: (input) => run(client["question.answer"](input)),
  previewDream: (workspaceId, input = {}) =>
    run(
      client["dream.preview"]({
        workspaceId,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...dreamScope(input),
      }),
    ),
  startDream: (workspaceId, input) =>
    run(
      client["dream.start"]({
        workspaceId,
        kind: input.kind,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...dreamScope(input),
        ...(input.threadIds === undefined ? {} : { threadIds: [...input.threadIds] }),
        ...(input.agentSessions === undefined ? {} : { agentSessions: [...input.agentSessions] }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.model === undefined ? {} : { model: input.model }),
      }),
    ),
  listDreams: (workspaceId) => run(client["dream.list"]({ workspaceId })),
  reviewDream: (dreamId) => run(client["dream.review"]({ dreamId })),
  cancelDream: (dreamId) => run(client["dream.cancel"]({ dreamId })),
  adoptDream: (dreamId, { resolutions, basedOn, outputDigest, memoryDigest } = {}) =>
    run(
      client["dream.adopt"]({
        dreamId,
        ...(resolutions === undefined ? {} : { resolutions }),
        ...(basedOn === undefined ? {} : { basedOn }),
        ...(outputDigest === undefined ? {} : { outputDigest }),
        ...(memoryDigest === undefined ? {} : { memoryDigest }),
      }),
    ),
  mergeDreamConflict: (dreamId, path) => run(client["dream.merge"]({ dreamId, path })),
  discardDream: (dreamId) => run(client["dream.discard"]({ dreamId })),
});

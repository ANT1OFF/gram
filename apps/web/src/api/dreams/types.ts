import type {
  AnswerQuestionInput,
  AnswerQuestionResult,
  AutomaticDreamStatus,
  Dream,
  DreamId,
  DreamMerge,
  DreamReview,
  ImportPreview,
  MemoryFileInfo,
  MemoryVersionInfo,
  MemoryWrite,
  WorkspaceId,
} from "@gram/contracts";

import type { AdoptDreamInput, DreamPreviewInput, StartDreamInput } from "../types";

/** `dream.*`, `memory.*` and `question.answer`: a workspace's memory, its questions and dreams. */
export interface DreamsApi {
  automaticDreamStatus(workspaceId: WorkspaceId): Promise<AutomaticDreamStatus>;
  /** The files of the workspace's adopted memory version. */
  listMemory(workspaceId: WorkspaceId): Promise<readonly MemoryFileInfo[]>;
  readMemory(workspaceId: WorkspaceId, path: string): Promise<{ path: string; content: string }>;
  /** Rejects with `InvalidState` naming the cap or the path rule a write breaks. */
  writeMemory(workspaceId: WorkspaceId, path: string, content: string): Promise<MemoryWrite>;
  deleteMemory(workspaceId: WorkspaceId, path: string): Promise<MemoryWrite>;
  /** The kept versions, oldest first. */
  listMemoryVersions(workspaceId: WorkspaceId): Promise<readonly MemoryVersionInfo[]>;
  /** Points memory back at a kept version; nothing is copied or deleted. */
  restoreMemory(workspaceId: WorkspaceId, version: string): Promise<void>;
  /**
   * The user's answer to an open question in `questions.md`: closes its entry as answered and sends
   * the answer to the orchestrator, steered while it runs. Rejects with `InvalidState` when the entry
   * is closed already or gone, or there is no orchestrator open.
   */
  answerQuestion(input: AnswerQuestionInput): Promise<AnswerQuestionResult>;
  /** What an import or a dream would read, counted before anything runs. */
  previewDream(workspaceId: WorkspaceId, input?: DreamPreviewInput): Promise<ImportPreview>;
  /** Starts a dream as a visible thread; one runs per workspace at a time. */
  startDream(workspaceId: WorkspaceId, input: StartDreamInput): Promise<Dream>;
  /** Newest first. */
  listDreams(workspaceId: WorkspaceId): Promise<readonly Dream[]>;
  /** The dream's output against the memory it started from, with live writes since as conflicts. */
  reviewDream(dreamId: DreamId): Promise<DreamReview>;
  cancelDream(dreamId: DreamId): Promise<Dream>;
  /** Rejects with `InvalidState` ("review again") when memory or the output moved since the review. */
  adoptDream(dreamId: DreamId, input?: AdoptDreamInput): Promise<Dream>;
  /**
   * Starts a model's merge of both sides of one conflict, on the dream's own model; resolves with
   * it running. `dreams.changed` says when it ends, and the review carries it as the file's `merge`.
   */
  mergeDreamConflict(dreamId: DreamId, path: string): Promise<DreamMerge>;
  /** Deletes the dream's folder and row. Rejects with `InvalidState` while it runs. */
  discardDream(dreamId: DreamId): Promise<void>;
}

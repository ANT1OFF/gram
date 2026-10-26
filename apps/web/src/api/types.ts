import type {
  CheckoutRequest,
  DraftId,
  MessageId,
  ModelRef,
  PermissionMode,
  ProjectId,
  RequestAnswer,
  RequestId,
  ServerEvent,
  Thread,
  ThreadFeedEvent,
  ThreadId,
  UserInput,
  OrchestratorCharter,
  WorkspaceId,
  DreamAgentSession,
  DreamKind,
  DreamMode,
  DreamResolution,
} from "@gram/contracts";

import type { AgentRuntimeApi } from "./agent-runtime/types";
import type { AgentSupportApi } from "./agent-support/types";
import type { AppApi } from "./app/types";
import type { BranchesApi } from "./branches/types";
import type { ComposerApi } from "./composer/types";
import type { ConnectorsApi } from "./connectors/types";
import type { DreamsApi } from "./dreams/types";
import type { FilesApi } from "./files/types";
import type { KeybindingsApi } from "./keybindings/types";
import type { LabelsApi } from "./labels/types";
import type { OrchestrationApi } from "./orchestration/types";
import type { PrPeopleApi } from "./pr-people/types";
import type { ProfilesApi } from "./profiles/types";
import type { ProjectsApi } from "./projects/types";
import type { PullRequestsApi } from "./pull-requests/types";
import type { ReviewRequestsApi } from "./review-requests/types";
import type { ThreadWakesApi } from "./thread-wakes/types";
import type { SessionsApi } from "./sessions/types";
import type { SettingsApi } from "./settings/types";
import type { SpeechApi } from "./speech/types";
import type { TerminalApi } from "./terminal/types";
import type { ThreadsApi } from "./threads/types";
import type { WaitsApi } from "./waits/types";
import type { WorktreesApi } from "./worktrees/types";

/** The merged PR a worktree's local branch is checked against before it's deleted. */
export interface MergedPrRef {
  repo: string;
  number: number;
}

export interface CloseThreadOptions {
  /**
   * Also delete the worktree on disk; `force` discards uncommitted changes instead of refusing.
   * `deleteBranch` also deletes its local branch when the server's check says it's safe.
   */
  removeWorktree?: { force: boolean; deleteBranch?: MergedPrRef };
  /** Picks from `pendingPermissions` to union back into the main checkout after removal. */
  permissionRules?: readonly string[];
  /** Refuse with `InvalidState`, stopping nothing, unless the thread is at rest. */
  onlyAtRest?: boolean;
}

export interface RemoveWorktreeOptions {
  /** Discard uncommitted changes instead of refusing with `WorktreeDirty`. */
  force: boolean;
  /** Picks from `worktreePendingPermissions` to union into the main checkout after removal. */
  permissionRules?: readonly string[];
  /** Also delete the worktree's local branch when the server's check says it's safe. */
  deleteBranch?: MergedPrRef;
}

/** A workspace to create, or with `id` the one to rename and give these projects. */
export interface SaveWorkspaceInput {
  readonly id?: WorkspaceId | undefined;
  readonly name: string;
  readonly projectIds: readonly [ProjectId, ...ProjectId[]];
  /** Where the orchestrator's own session runs; one of `projectIds`. */
  readonly homeProjectId: ProjectId;
  /** A new workspace's whole charter; absent starts with the default and the app's roster. Refused with `id`. */
  readonly charter?: OrchestratorCharter | undefined;
}

/** Which workspace's orchestrator to open: a saved one, or the one-project workspace of a project. */
export type OpenOrchestratorTarget =
  | { readonly workspaceId: WorkspaceId }
  | { readonly projectId: ProjectId };

/** One answer of `respondMany`. */
export interface RespondManyAnswer {
  readonly threadId: ThreadId;
  readonly requestId: RequestId;
  readonly answer: RequestAnswer;
}

/** A feature's or a group's stage as the user sets it: exactly one of `feature` and `group`. */
export interface SetStageInput {
  readonly feature?: string | undefined;
  readonly group?: string | undefined;
  readonly stage: string;
  /** Absent keeps the plan the target has, and `stage` must then be one of it. */
  readonly plan?: readonly string[] | undefined;
  readonly note?: string | undefined;
}

/** What an import or a dream would read; the same fields `startDream` takes, so a preview is what runs. */
export interface DreamPreviewInput {
  /** `dream` counts what is past the watermarks instead of the agents' histories. */
  readonly kind?: DreamKind | undefined;
  /** What a `dream` reads, in tokens; the server's default is `DREAM_BUDGET_TOKENS_DEFAULT`. */
  readonly budgetTokens?: number | undefined;
  readonly projectIds?: readonly ProjectId[] | undefined;
  /** The newest sessions read per repo; the server's default is 30. */
  readonly perRepo?: number | undefined;
  /** Also count (or, on a start, copy in) Claude Code's memory files for the workspace's folders. */
  readonly includeMemory?: boolean | undefined;
}

export interface StartDreamInput extends DreamPreviewInput {
  readonly kind: DreamKind;
  readonly mode?: DreamMode | undefined;
  readonly threadIds?: readonly ThreadId[] | undefined;
  readonly agentSessions?: readonly DreamAgentSession[] | undefined;
  readonly instructions?: string | undefined;
  /** Absent runs on the user's default model when its agent may dream, else Claude. */
  readonly model?: ModelRef | undefined;
}

/** What the user saw when they pressed Adopt, so the server can refuse an adoption of anything else. */
export interface AdoptDreamInput {
  /** A side for every `conflict` of the review, by path; `merged` takes the file's finished merge. */
  readonly resolutions?: Readonly<Record<string, DreamResolution>> | undefined;
  /** `DreamReview.memoryVersion`. */
  readonly basedOn?: string | undefined;
  /** `DreamReview.outputDigest`. */
  readonly outputDigest?: string | undefined;
  readonly memoryDigest?: string | undefined;
}

export type ApiServerEvent = ServerEvent;
/**
 * The contract feed plus `subscribed`, which the api yields before each (re)subscription so the
 * store can tell a subscription head (buffer until `caughtUp`) from a live replace-all `messages`
 * (e.g. after a rewind), which the store publishes without waiting for its `caughtUp`.
 */
export type ApiThreadFeedEvent = ThreadFeedEvent | { type: "subscribed" };

/** Where a feed resumes from: `thread.subscribe`'s `afterRev` and `from`. */
export interface FeedResume {
  readonly afterRev: number;
  /** The oldest message the feed holds. */
  readonly from?: string | undefined;
}

export interface CreateThreadInput {
  projectRoot: string;
  checkout: CheckoutRequest;
  model?: ModelRef;
  mode?: PermissionMode;
  title?: string;
  input?: UserInput;
  /** Continue this agent session (from `listSessions`) instead of starting a fresh one. */
  resumeSessionId?: string;
  /** With `resumeSessionId`: the Codex home that session was listed in. */
  codexHome?: NonNullable<Thread["codexHome"]>;
  /** Adopts the attachments uploaded for this draft; `input.attachments` names their staged paths. */
  draftId?: DraftId;
}

export interface ForkThreadOptions {
  /** Fork after this message; the latest message when absent. */
  fromMessageId?: MessageId;
  /** The source thread's checkout when absent. */
  checkout?: CheckoutRequest;
  title?: string;
}

export interface SearchThreadsOptions {
  /** Only this thread's messages. */
  threadId?: ThreadId;
  limit?: number;
}

/** `expired`: the server rejects this window's session (its launch token changed); retrying can't help. */
type ConnectionStatus = "connecting" | "open" | "reconnecting" | "expired";

/**
 * Why the server is unavailable, said by what stands in front of it: a 503 to the `/?boot=0` probe
 * with a JSON `message`.
 */
export interface ConnectionNotice {
  readonly message: string;
  readonly detail?: string;
}

export interface ConnectionState {
  readonly status: ConnectionStatus;
  /** Failed attempts since the connection was last open. */
  readonly attempt?: number;
  /** Epoch ms of the next attempt while reconnecting. */
  readonly retryAt?: number;
  /** While reconnecting, why, when the probe was told; the banner says it instead of "Reconnecting". */
  readonly notice?: ConnectionNotice;
}

/** The socket's state for the reconnect banner; `get` returns a stable object between changes. */
export interface ConnectionMonitor {
  get(): ConnectionState;
  subscribe(listener: () => void): () => void;
  /** Skips the backoff wait and reconnects now. */
  retryNow(): void;
}

/**
 * The only way components talk to the server: Promises for commands, AsyncIterables for feeds.
 * Iteration ends when `signal` aborts. Rejections carry the contract's tagged errors (`_tag`); no
 * Effect types cross this boundary.
 */
/** A pasted or dropped file for `uploadAttachment`. */
export interface UploadFile {
  readonly name: string;
  /** `File.type`; may be empty. */
  readonly mediaType: string;
  /** The bytes, base64-encoded. */
  readonly data: string;
}

/** Where an upload goes: an existing thread, or staged for a `/new` draft until `createThread`. */
export type AttachmentTarget = { readonly threadId: ThreadId } | { readonly draftId: DraftId };

export interface Api
  extends
    AgentRuntimeApi,
    AgentSupportApi,
    AppApi,
    BranchesApi,
    ComposerApi,
    ConnectorsApi,
    DreamsApi,
    FilesApi,
    KeybindingsApi,
    LabelsApi,
    OrchestrationApi,
    PrPeopleApi,
    ProfilesApi,
    ProjectsApi,
    PullRequestsApi,
    ReviewRequestsApi,
    SessionsApi,
    SettingsApi,
    SpeechApi,
    TerminalApi,
    ThreadsApi,
    ThreadWakesApi,
    WaitsApi,
    WorktreesApi {
  readonly kind: "mock" | "rpc";
  readonly connection: ConnectionMonitor;
}

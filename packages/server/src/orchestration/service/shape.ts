// The orchestration service's public contract: `OrchestrationShape` and the inputs and results of its
// tools. `service.ts` re-exports all of it, so importers keep importing from there.
import {
  type AppToolError,
  type InvalidState,
  type NotFound,
  type WorkspaceId,
  type FeatureCards,
  type AgentUnavailable,
  type Autonomy,
  type BriefPriority,
  type Handoff,
  type ModelRef,
  type ReopenedMembership,
  type OrchestratorCharter,
  type OrchestratorLedger,
  type JoinTarget,
  type ProjectId,
  type ReasoningVariant,
  type Thread,
  type ThreadId,
  type ThreadNotFound,
  type UserInput,
  type WorkerAnswer,
  type WorkerQuestion,
  type AskQuestionInput,
  type AnswerWorkerQuestionInput,
  type DismissWorkerQuestionInput,
  type WorkerReport,
  type WorkerReportState,
  type WorkerState,
  type WorkspaceState,
  type StartTaskInput,
  type TaskModelSelection,
  type SettingsRequirement,
  type SettingsWrite,
} from "@gram/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { type ClosedWorker, type SettingsAuditEntry } from "../../persistence/thread-store.ts";
import { type WakeInput } from "../../wakes/thread-wakes.ts";
import { type CreateThreadInput } from "../../runtime/thread-runtimes.ts";
import { type RouteAlternative, type RouteOffer } from "../limit-pause.ts";
import { type SentRequest } from "../outbox.ts";
import { type RosterEntry, type RosterUnavailable } from "../rules.ts";

/** A thread with authority, and the workspace it has it over. */
export interface Authority {
  readonly thread: Thread;
  readonly state: WorkspaceState;
}

/** `spawn_worker`'s input once the tool has decoded it. */
export interface SpawnWorkerInput {
  readonly project: string;
  /** Further projects the worker gets a worktree in, on the same branch. */
  readonly alsoIn?: ReadonlyArray<string> | undefined;
  readonly feature: string;
  readonly title: string;
  readonly brief: string;
  readonly branch?: string | undefined;
  readonly base?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: ReasoningVariant | undefined;
  readonly scope?: ReadonlyArray<string> | undefined;
  readonly readAlso?: ReadonlyArray<string> | undefined;
  readonly clientRequestId?: string | undefined;
  /** The group the feature joins, made if need be. */
  readonly group?: string | undefined;
  /**
   * Which repository each repo Gram didn't know yet was, by its folder, when `pinRepos`
   * pinned it before the card (`repoIdentity`); set by the tool's `resolve`, never by the agent.
   */
  readonly identities?: Readonly<Record<string, string>> | undefined;
  /** `low` may be held near a subscription limit until it resets (`HeldBrief`). */
  readonly priority?: BriefPriority | undefined;
  /**
   * `stay` keeps the model at a limit after a route offer (`routeAtLimit`): the spawn is held,
   * paused or queued as it would be with routing off.
   */
  readonly atLimit?: "stay" | undefined;
  /** The brief's checklist, seeded as the worker's first plan; kept with a held brief. */
  readonly plan?: ReadonlyArray<string> | undefined;
}

/** What `spawn_worker` tells the orchestrator about a low-priority brief it held instead. */
export interface HeldSpawn {
  readonly held: true;
  /** The held brief's id, as the ledger's `held` lists it. */
  readonly id: string;
  readonly feature: string;
  readonly title: string;
  readonly project: string;
  /** Epoch ms the brief becomes eligible for release or a recovery probe. */
  readonly until: number;
  readonly note: string;
  /**
   * With `routeAtLimit` on, the worker models clear of the limit it could be retargeted to
   * instead (`manage_held_spawn`); absent when routing is off or none is clear.
   */
  readonly alternatives?: ReadonlyArray<RouteAlternative>;
}

/** What a delegated `send_message` did, as `sendOnce` records it. */
export type SentMessage = Omit<SentRequest, "at" | "fingerprint">;

/** A retried `send_message` that `sendOnce` answered from its record. */
export interface RepeatedSend extends SentMessage {
  readonly repeated: true;
}

/** A stage for a feature or a group, exactly one of the two, as `set_stage` and the user's RPC give it. */
export interface StageInput {
  readonly feature?: string | undefined;
  readonly group?: string | undefined;
  readonly stage: string;
  readonly plan?: ReadonlyArray<string> | undefined;
  readonly note?: string | undefined;
}

/** A feature's group, or none to take it out of the one it is in. */
export interface GroupInput {
  readonly feature: string;
  readonly group?: string | undefined;
}

/** `answer_worker`'s input once the tool has decoded it. */
export interface AnswerWorkerInput {
  readonly threadId: string;
  readonly requestId: string;
  readonly answer: string;
}

/** A worktree a worker holds in a repo other than its own, as the tools name it. */
export interface WorkerWorktree {
  readonly project: string;
  readonly worktree: string;
  readonly branch?: string | undefined;
}

/** `add_worker_repo`'s input once the tool has decoded it. */
export interface AddWorkerRepoInput {
  readonly threadId: string;
  readonly project: string;
  /**
   * Which repository each repo Gram didn't know yet was, by its folder, when `pinRepos`
   * pinned it before the card (`repoIdentity`); set by the tool's `resolve`, never by the agent.
   */
  readonly identities?: Readonly<Record<string, string>> | undefined;
}

/** What `add_worker_repo` tells the orchestrator: the worktree it made, and that the worker was told. */
export interface AddedWorkerRepo extends WorkerWorktree {
  readonly threadId: ThreadId;
  readonly title: string;
  /** Whether the message naming the worktree went out at once or waits behind the worker's turn. */
  readonly delivered: "sent" | "queued";
}

/** How a thread joins a workspace as a worker, from the user's menu or `adopt_thread`. */
export interface JoinInput {
  /** The feature it goes under; without one, it is named from its branch or its title. */
  readonly feature?: string | undefined;
  readonly group?: string | undefined;
  /**
   * An existing git worktree the thread is to work in from now on, when that isn't its checkout:
   * a thread that made one with its shell, in a repo Gram knows. It moves there once idle.
   */
  readonly worktree?: string | undefined;
}

/** `adopt_thread`'s input: the thread to take on, and how it joins. */
export interface AdoptThreadInput extends JoinInput {
  readonly threadId: string;
  /**
   * What the card was raised on (`pinAdopt`): the project it works in, the branch of its checkout
   * and the repos it adds. Set by the tool's `resolve`, never by the agent; the handler refuses a
   * plan that no longer matches it.
   */
  readonly pinned?: AdoptPin | undefined;
}

/** What `adopt_thread`'s card named, which the call after the user's yes must still be. */
export interface AdoptPin {
  readonly project: ProjectId;
  /** The folder it works in, and which folder that was (`folderIdentity`). */
  readonly worktree: string;
  readonly folder?: string | undefined;
  readonly branch?: string | undefined;
  /** Each repo it adds, by project id, as the repository found at its root (`repoIdentity`). */
  readonly outside: Readonly<Record<string, string>>;
}

/** What `adopt_thread` tells the orchestrator about the worker it took on. */
export interface AdoptedThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly feature: string;
  readonly project: string;
  readonly branch?: string | undefined;
  readonly worktree: string;
  /** The workspace it was a worker of before, by name. */
  readonly movedFrom?: string | undefined;
}

/** What `spawn_worker` tells the orchestrator about the worker it made, or had already made. */
export interface SpawnedWorker {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly feature: string;
  readonly project: string;
  readonly branch?: string | undefined;
  readonly worktree: string;
  /** Its worktrees in the `alsoIn` repos. */
  readonly alsoIn?: ReadonlyArray<WorkerWorktree> | undefined;
  /** The worker model it runs on, as `agent:model`. */
  readonly model: string;
  readonly mode: Thread["mode"];
  /** Present when the same `clientRequestId` had already made this worker. */
  readonly existing?: true | undefined;
  readonly warning?: string | undefined;
  /** Its login is at a usage limit: the brief is queued, and starts at the reset on its own. */
  readonly queued?: string | undefined;
}

/** What `Orchestration.reopen` asks `create` to put in a reopened thread's row. */
export type ReopenFields = Pick<
  CreateThreadInput,
  "role" | "workspaceId" | "spawnedBy" | "deferOpen"
>;

export interface OrchestrationShape {
  readonly listWorkspaces: Effect.Effect<ReadonlyArray<WorkspaceState>>;
  /**
   * Creates a workspace with `charter`, else with the default charter and the app's roster; with
   * `id`, renames one and replaces its projects, and refuses a charter (`setCharter` changes one).
   */
  saveWorkspace(input: {
    readonly id?: WorkspaceId | undefined;
    readonly name: string;
    readonly projectIds: WorkspaceState["workspace"]["projectIds"];
    readonly homeProjectId: ProjectId;
    readonly charter?: OrchestratorCharter | undefined;
  }): Effect.Effect<WorkspaceState, NotFound | InvalidState>;
  /**
   * `saveWorkspace` for a change by chat the user approved, its audit row written in the same
   * transaction: a new workspace, or with `id` one whose name, projects and home still hold
   * `before`. `undefined` when they have moved: nothing was written.
   */
  saveWorkspaceApproved(
    input: Parameters<OrchestrationShape["saveWorkspace"]>[0],
    audit: SettingsAuditEntry,
    before?: Pick<WorkspaceState["workspace"], "name" | "projectIds" | "homeProjectId">,
  ): Effect.Effect<
    { readonly state: WorkspaceState; readonly auditSeq: number } | undefined,
    NotFound | InvalidState
  >;
  /**
   * The workspace's memory directory stays on disk: what an orchestrator learned is the user's,
   * and removing a workspace is no request to delete it.
   */
  removeWorkspace(workspaceId: WorkspaceId): Effect.Effect<void, NotFound | InvalidState>;
  /**
   * The workspace's orchestrator thread, created with the slot when nobody holds it; `projectId`
   * names that project's one-project workspace, made on first use. A parked holder is returned as
   * it is.
   */
  open(
    target:
      | { readonly workspaceId: WorkspaceId }
      | {
          readonly projectId: ProjectId;
          /** The level the workspace starts at if this makes it; one that exists keeps its own. */
          readonly autonomy?: Autonomy | undefined;
        },
    selected?: ModelRef,
    /** Refuse an existing or concurrently won slot; explicit bot creation cannot adopt it. */
    requireNew?: boolean,
  ): Effect.Effect<Thread, NotFound | InvalidState | AgentUnavailable>;
  taskPreflight(
    input: Pick<StartTaskInput, "target" | "direct" | "autonomy">,
  ): Effect.Effect<TaskModelSelection, NotFound | InvalidState | AgentUnavailable>;
  /** Resolve outside the edit lock, then refuse stale evidence before startup side effects. */
  withTaskStartup<A, E>(
    input: Pick<StartTaskInput, "target" | "direct" | "autonomy">,
    selected: TaskModelSelection | undefined,
    run: (current: TaskModelSelection) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | NotFound | InvalidState | AgentUnavailable>;
  /**
   * A changed `autonomy` reloads the orchestrator's session and its live workers' once each is
   * idle: a session's outward gate and what its prompt says about asking are fixed when it opens.
   * Lowering it from `full` is refused, with the threads in the way named, while the orchestrator
   * or a live worker couldn't open under a gate (`gateNeeds`).
   */
  setCharter(
    workspaceId: WorkspaceId,
    charter: OrchestratorCharter,
  ): Effect.Effect<WorkspaceState, NotFound | InvalidState>;
  /** Pausing is the user's (`reason: "user"`); resuming clears a pause of any reason and wakes once. */
  setPaused(workspaceId: WorkspaceId, paused: boolean): Effect.Effect<WorkspaceState, NotFound>;
  /**
   * An approved change by chat to the charter: `writes` applied to the charter as it is stored
   * when the write runs, only while each field still holds its `before`, with the audit row in the
   * same transaction; the UI's checks and what a charter change sets off are as for `setCharter`.
   * `InvalidState` when a field has moved: nothing was written.
   */
  changeCharter(
    workspaceId: WorkspaceId,
    writes: ReadonlyArray<SettingsWrite>,
    audit: SettingsAuditEntry,
    /** App settings the card was drawn from; checked in the same transaction. */
    requires?: ReadonlyArray<SettingsRequirement>,
  ): Effect.Effect<
    { readonly state: WorkspaceState; readonly auditSeq: number },
    NotFound | InvalidState
  >;
  /**
   * A pause or resume with its audit row, as `changeCharter`: only from the state it was asked
   * against. No agent reaches it: pausing and resuming are the user's alone.
   */
  changePaused(
    workspaceId: WorkspaceId,
    paused: boolean,
    audit: SettingsAuditEntry,
  ): Effect.Effect<
    { readonly state: WorkspaceState; readonly auditSeq: number },
    NotFound | InvalidState
  >;
  /**
   * Runs `launch` unless the workspace is paused, read at once and with no pause able to land until
   * it is done: a merge's launch, the last step after its yielding checks. A launch under way is in
   * flight, and a pause waits for it rather than pretend it can call it back. `undefined` when
   * paused or gone.
   */
  launchUnlessPaused<A, E, R>(
    workspaceId: WorkspaceId,
    launch: Effect.Effect<A, E, R>,
  ): Effect.Effect<A | undefined, E, R>;
  /**
   * Which of the workspace's worker models can't be spawned on here, by their index in the
   * charter's roster, and why: what `list_workers` marks `unavailable`.
   */
  workerModelAvailability(workspaceId: WorkspaceId): Effect.Effect<RosterUnavailable, NotFound>;
  ledger(workspaceId: WorkspaceId): Effect.Effect<OrchestratorLedger, NotFound>;
  /**
   * The ledger now, then again whenever something it shows changes, `LEDGER_WATCH_DEBOUNCE` after
   * the last change; one that reads as the last one sent did is left out. Ends with its consumer.
   */
  watchLedger(workspaceId: WorkspaceId): Stream.Stream<OrchestratorLedger, NotFound>;
  /**
   * The workspace's feature cards, brought up to date with the ledger first: a card whose feature
   * shows anything new gets the next version, and is persisted before it is returned.
   */
  featureCards(workspaceId: WorkspaceId): Effect.Effect<FeatureCards, NotFound>;
  /**
   * The cards now, then again whenever one of them changes (a worker's status, now line, PR or
   * stage), `LEDGER_WATCH_DEBOUNCE` after the last change. Ends with its consumer.
   */
  watchFeatureCards(workspaceId: WorkspaceId): Stream.Stream<FeatureCards, NotFound>;
  /**
   * The user's stage for a feature or a group. The orchestrator is told in its next digest,
   * which this alone doesn't send. `InvalidState` carries why a stage was refused.
   */
  setStage(
    workspaceId: WorkspaceId,
    input: StageInput,
  ): Effect.Effect<WorkspaceState, NotFound | InvalidState>;
  /** The user's grouping of a feature; without a group, its removal from the one it is in. */
  setGroup(
    workspaceId: WorkspaceId,
    input: GroupInput,
  ): Effect.Effect<WorkspaceState, NotFound | InvalidState>;
  /**
   * The user's Archive on a feature: parks each of its workers, so the ledger reads them archived
   * and the feature leaves the Board. Refused while one of them runs or waits on the user, which
   * parking would only hide. The orchestrator is told in its next digest. Answers the threads parked.
   */
  archiveFeature(
    workspaceId: WorkspaceId,
    feature: string,
  ): Effect.Effect<ReadonlyArray<ThreadId>, NotFound | InvalidState>;
  /**
   * The user's Pause or Resume on a feature. Paused, its running workers are interrupted, nothing
   * about its workers wakes the orchestrator, which can't message them or spawn for the feature, and
   * its held briefs wait. The orchestrator reads either in its next digest; a resume wakes it.
   */
  setFeaturePaused(
    workspaceId: WorkspaceId,
    feature: string,
    paused: boolean,
  ): Effect.Effect<WorkspaceState, NotFound | InvalidState>;
  /**
   * The user's Rename of a feature: in one transaction its workers, stage, groups, pause, card,
   * held briefs and the outbox's snapshots take the new slug, and the next digest says so. Refused
   * for a name that isn't a slug and for one another feature has. Branches keep their names. The
   * new slug.
   */
  renameFeature(
    workspaceId: WorkspaceId,
    feature: string,
    to: string,
  ): Effect.Effect<string, NotFound | InvalidState>;
  /** Makes a worker a plain thread; its session reloads once idle to lose the worker's tools. */
  detach(threadId: ThreadId): Effect.Effect<Thread, ThreadNotFound | InvalidState>;
  /**
   * The user's Add to workspace… and Move to workspace…: the thread becomes a worker of the
   * workspace's orchestrator, leaving the one it was a worker of. `addRepos` is the user's yes to
   * its repos joining the workspace too; without it, a repo outside the workspace is refused.
   */
  joinWorkspace(
    threadId: ThreadId,
    workspaceId: WorkspaceId,
    input: JoinInput & { readonly addRepos?: boolean | undefined },
  ): Effect.Effect<Thread, ThreadNotFound | NotFound | InvalidState>;
  /**
   * The workspaces the thread can join or move to, and the names of its repos each would add,
   * matched to projects by resolved path as the join itself matches them.
   */
  joinTargets(threadId: ThreadId): Effect.Effect<ReadonlyArray<JoinTarget>, ThreadNotFound>;
  /**
   * `adopt_thread`'s plan pinned before its card, or the refusal it would meet: the call is
   * refused before the user is asked rather than after. Reads only; the tool's `resolve`.
   */
  pinAdopt(callerId: ThreadId, input: AdoptThreadInput): Effect.Effect<AdoptPin, AppToolError>;
  /** `adopt_thread`'s card: what joins, from where, and any repo or cap it crosses. Reads only. */
  describeAdopt(callerId: ThreadId, input: AdoptThreadInput): Effect.Effect<string>;
  /** `adopt_thread`, once the user has said yes on its card. */
  adoptThread(
    callerId: ThreadId,
    input: AdoptThreadInput,
  ): Effect.Effect<AdoptedThread, AppToolError>;
  /**
   * Hands a worker the user wrote to back to its orchestrator: clears `userIntervened` and tells
   * the next digest, without a word to the worker. A worker that isn't held is left as it is.
   */
  releaseWorker(threadId: ThreadId): Effect.Effect<void, ThreadNotFound | InvalidState>;
  /**
   * "Take over": the hold a message the user types into a worker puts on it, by the same path
   * (`onUserInput`), with nothing sent. A worker already held has its hold renewed.
   */
  takeOverWorker(threadId: ThreadId): Effect.Effect<void, ThreadNotFound | InvalidState>;
  /**
   * Replaces the orchestrator's agent session with a fresh one under the same thread, the memory
   * as the bridge: a checkpoint prompt first, then, when that turn has ended, the fresh
   * session and a `boot` digest. Returns once it is under way, not once it is done. `InvalidState`
   * without an orchestrator, while another handoff is running, and for a thread that has ended.
   * An orchestrator in `error` skips the checkpoint.
   */
  handoff(
    workspaceId: WorkspaceId,
    reason: Handoff["reason"],
    target?: ModelRef,
  ): Effect.Effect<Thread, NotFound | InvalidState>;
  retrySwitch(workspaceId: WorkspaceId): Effect.Effect<Thread, NotFound | InvalidState>;
  cancelSwitch(workspaceId: WorkspaceId): Effect.Effect<void, NotFound | InvalidState>;
  /** Refuses a model change that would leave a role-bearing or spawned thread on an unadmitted agent. */
  checkModelChange(threadId: ThreadId, model: ModelRef): Effect.Effect<void, InvalidState>;
  /**
   * ⌘⇧T on a closed thread: `create` makes it again with what of its place in a workspace
   * can come back, then an orchestrator claims its slot again and its `workers`, the ones its
   * close detached that are still in the workspace and nobody else's, are its own again. A worker
   * whose orchestrator still holds the slot is its worker again; one that can't be either comes
   * back in its workspace, as its orchestrator's close would have left it. `membership` is absent
   * for a thread that was in no workspace.
   */
  reopen<E>(
    stored: Thread,
    workers: ReadonlyArray<ClosedWorker>,
    create: (fields: ReopenFields) => Effect.Effect<Thread, E>,
  ): Effect.Effect<
    { readonly thread: Thread; readonly membership?: ReopenedMembership | undefined },
    E
  >;

  /** `undefined` unless the thread is its workspace's orchestrator right now. */
  authorityOf(threadId: ThreadId): Effect.Effect<Authority | undefined>;
  /** The delegation rule for one call; reads only, since a gate may ask twice. */
  isDelegated(callerId: ThreadId, targetId: string): Effect.Effect<boolean>;
  /** Resolves an active worker's current bound parent, regardless of autonomy, or refuses before approval. */
  resolveWorkerParent(callerId: ThreadId): Effect.Effect<
    {
      readonly threadId: ThreadId;
      readonly workspaceId: WorkspaceId;
    },
    AppToolError
  >;
  /** Message-only worker delegation to the bound parent or siblings at full autonomy; reads only. */
  isWorkerSend(callerId: ThreadId, targetId: string): Effect.Effect<boolean>;
  /** Rechecks current worker relationships, workspace pause and user holds before delivery. */
  checkWorkerMessage(callerId: ThreadId, targetId: ThreadId): Effect.Effect<void, AppToolError>;
  /**
   * `named` pinned before the approval check: a known project as its id, a repo Gram doesn't
   * know yet as its folder, with which repository is there (`identities`); a name that resolves to
   * nothing is refused. Reads only; a tool's `resolve`.
   */
  pinRepos(
    callerId: ThreadId,
    tool: string,
    named: ReadonlyArray<string>,
  ): Effect.Effect<
    {
      readonly pins: ReadonlyArray<string>;
      readonly identities: Readonly<Record<string, string>>;
    },
    AppToolError
  >;
  /** Whether this spawn needs a card: a project outside the workspace, or one worker past the cap. Reads only. */
  spawnNeedsApproval(callerId: ThreadId, input: SpawnWorkerInput): Effect.Effect<boolean>;
  /** The card's text for such a spawn. */
  describeSpawn(callerId: ThreadId, input: SpawnWorkerInput): Effect.Effect<string>;
  /**
   * A worker for the orchestrator's brief; a low-priority one at a subscription limit is held
   * instead (`HeldSpawn`), and spawned when the limit resets or a turn on its agent goes through.
   */
  spawnWorker(
    callerId: ThreadId,
    input: SpawnWorkerInput,
  ): Effect.Effect<SpawnedWorker | HeldSpawn | RouteOffer, AppToolError>;
  /**
   * The caller's workspace's worker brief footer (`briefFooterOf`), for `spawn_worker` to append
   * to the brief; `undefined` without one, or for a thread that isn't the workspace's orchestrator.
   */
  briefFooter(callerId: ThreadId): Effect.Effect<string | undefined>;
  /** Manage only held briefs belonging to the current orchestrator; serialised with releases. */
  manageHeldSpawn(
    callerId: ThreadId,
    input: { readonly id: string; readonly action: "cancel" | "retarget"; readonly model?: string },
  ): Effect.Effect<unknown, AppToolError>;
  /** The user starts a held brief now, without waiting for the reset; the worker made. */
  releaseHeldBrief(
    workspaceId: WorkspaceId,
    id: string,
  ): Effect.Effect<Thread, NotFound | InvalidState>;
  /**
   * New task, straight to a worker: one worker of the workspace's orchestrator, started from what
   * the user wrote in a new worktree of `projectId`, on a feature of its own named from it, and
   * held as the user's since they wrote its first input. Refused without an orchestrator.
   */
  startWorker(
    workspaceId: WorkspaceId,
    input: {
      readonly id: ThreadId;
      readonly projectId: ProjectId;
      readonly base?: string | undefined;
      readonly input: UserInput;
      readonly model?: ModelRef;
    },
  ): Effect.Effect<Thread, NotFound | InvalidState | ThreadNotFound>;
  /** Whether `add_worker_repo` needs a card: only for a project outside the workspace. Reads only. */
  addRepoNeedsApproval(callerId: ThreadId, input: AddWorkerRepoInput): Effect.Effect<boolean>;
  describeAddRepo(callerId: ThreadId, input: AddWorkerRepoInput): Effect.Effect<string>;
  /** Gives one of the caller's workers a worktree in another repo, on its branch, and tells it. */
  addWorkerRepo(
    callerId: ThreadId,
    input: AddWorkerRepoInput,
  ): Effect.Effect<AddedWorkerRepo, AppToolError>;
  /**
   * The `full`-autonomy delegation of an outward action for one call (`fullAutonomyAllows`); reads
   * only, since a gate may ask twice, and anything that goes wrong answers `false`.
   */
  fullAutonomyAllows(callerId: ThreadId, targetId: string): Effect.Effect<boolean>;
  /** The ledger as `list_workers` shows it to the orchestrator, and the worker models it may name. */
  listWorkers(
    callerId: ThreadId,
    options: {
      readonly includeArchived?: boolean | undefined;
      readonly since?: number | undefined;
      /** Only workers in one of these states. */
      readonly states?: ReadonlyArray<WorkerState> | undefined;
      /** Only workers that count against the cap. */
      readonly live?: boolean | undefined;
    },
  ): Effect.Effect<
    OrchestratorLedger & {
      readonly autonomy: Autonomy;
      readonly workerModels: ReadonlyArray<RosterEntry>;
      /** The running Gram app's version and build (`appLabelOf`), when known. */
      readonly app?: string;
    },
    AppToolError
  >;
  /** `set_stage`: the orchestrator's stage for a feature or a group. Not a wake reason: it made it. */
  setStageAs(
    callerId: ThreadId,
    input: StageInput,
  ): Effect.Effect<
    { readonly feature?: string; readonly group?: string; readonly stage: WorkspaceStage },
    AppToolError
  >;
  /** `set_group`. */
  setGroupAs(
    callerId: ThreadId,
    input: GroupInput,
  ): Effect.Effect<{ readonly feature: string; readonly group?: string }, AppToolError>;
  /**
   * `answer_worker`: answers a question one of the caller's workers is waiting on, which only
   * `full` autonomy allows, and records it for both transcripts. The caller emits the parts.
   */
  answerWorker(
    callerId: ThreadId,
    input: AnswerWorkerInput,
  ): Effect.Effect<WorkerAnswer, AppToolError>;
  /**
   * `ask_question`: a worker's own question, put in triage with its orchestrator (or straight to the
   * user while paused), with a `question` report that wakes the orchestrator. `undefined` when no
   * orchestrator is listening.
   */
  askQuestion(
    workerId: ThreadId,
    input: AskQuestionInput,
  ): Effect.Effect<WorkerQuestion | undefined, AppToolError>;
  /** `forward_question`: one of the caller's workers' questions in triage, to the user. */
  forwardQuestion(
    callerId: ThreadId,
    input: { readonly questionId: string; readonly context?: string | undefined },
  ): Effect.Effect<WorkerQuestion, AppToolError>;
  /**
   * `answer_worker` with a `questionId`: the orchestrator answers a question still in triage, citing
   * what settles it, and the worker is sent the answer at once.
   */
  answerWorkerQuestion(
    callerId: ThreadId,
    input: { readonly questionId: string; readonly answer: string; readonly source: string },
  ): Effect.Effect<WorkerQuestion, AppToolError>;
  /** `workerQuestion.answer`: the user's answer, to the worker now and to the orchestrator's next digest. */
  answerQuestionAsUser(
    input: AnswerWorkerQuestionInput,
  ): Effect.Effect<WorkerQuestion, NotFound | InvalidState | ThreadNotFound | AgentUnavailable>;
  /** `workerQuestion.dismiss`: the user's dismissal, told to the worker and to the next digest. */
  dismissQuestionAsUser(
    input: DismissWorkerQuestionInput,
  ): Effect.Effect<WorkerQuestion, NotFound | InvalidState | ThreadNotFound | AgentUnavailable>;
  /**
   * Whether `callerId` is a worker its orchestrator still listens to, in a workspace at `full`
   * autonomy and not paused, so a merge of its own PR goes without a card (`workerMergesOwnAtFull`).
   * Whether the PR is its own is the caller's to check.
   */
  workerMergesOwn(callerId: ThreadId): Effect.Effect<boolean>;
  /**
   * `schedule_wake`: a wake the caller sets for itself, an orchestrator or a worker its orchestrator
   * still listens to. Kept in the workspace's outbox, so it survives a restart.
   */
  scheduleWake(
    callerId: ThreadId,
    input: WakeInput,
    /** The caller's wakes pending elsewhere (`ThreadWakes`), which count toward its cap. */
    elsewhere?: number,
  ): Effect.Effect<{ readonly id: string; readonly at: string }, AppToolError>;
  /** How many of `callerId`'s wakes its workspace's outbox holds, whatever its role now. */
  pendingWakesOf(callerId: ThreadId): Effect.Effect<number>;
  /**
   * Whether `callerId`'s wakes live in a workspace's outbox: it is an orchestrator, or a worker its
   * orchestrator still listens to. Every other thread's are its own (`wakes/thread-wakes.ts`).
   */
  keepsWakesOf(callerId: ThreadId): Effect.Effect<boolean>;
  /**
   * `cancel_wake`: drops one of the caller's own pending wakes from its workspace's outbox, or with
   * no id all of them, whether or not it still has the role it set them in.
   */
  cancelWake(
    callerId: ThreadId,
    id: string | undefined,
  ): Effect.Effect<{ readonly cancelled: number }, AppToolError>;
  /** Stores a worker's report and wakes its orchestrator; `undefined` when no orchestrator is listening. */
  recordReport(
    workerId: ThreadId,
    input: {
      readonly state: WorkerReportState;
      readonly summary: string;
      readonly evidence?: WorkerReport["evidence"] | undefined;
      readonly prUrl?: string | undefined;
      readonly interface?: string | undefined;
    },
  ): Effect.Effect<WorkerReport | undefined>;
  /** The orchestrator → worker loop guard, in place of `checkSend` for a delegated send. */
  checkSend(callerId: ThreadId, targetId: ThreadId): Effect.Effect<void, AppToolError>;
  /** Counts a delegated send, for the ledger and the rate limit. */
  noteMessage(callerId: ThreadId, targetId: ThreadId): Effect.Effect<void>;
  /**
   * Runs a delegated `send` once per retry id (sender-scoped for workers): a retry gets the
   * first send's record back as `repeated` and sends nothing, and the id reused for another thread
   * or another message (`fingerprint`, from `sendFingerprint`) is refused.
   */
  sendOnce<A extends SentMessage, E>(
    callerId: ThreadId,
    clientRequestId: string,
    targetId: ThreadId,
    fingerprint: string,
    send: Effect.Effect<A, E>,
  ): Effect.Effect<A | RepeatedSend, E | AppToolError>;
  /** Refuses a delegated `set_thread_model` outside the charter's worker models. */
  checkWorkerModel(callerId: ThreadId, model: ModelRef): Effect.Effect<void, AppToolError>;

  // -- Dreams' seam (`dreams.ts`) -----------------------------------------------------------
  /**
   * Puts one line in the workspace's next digest and schedules it, whatever the ledger diff says;
   * how an adopted dream tells the orchestrator to re-read its memory. Kept with the other
   * notes, so only the newest ten survive until a digest goes.
   */
  addNote(workspaceId: WorkspaceId, note: string): Effect.Effect<void>;
  /**
   * Puts one line in the workspace's next digest without waking anyone: it goes whenever the next
   * digest does. How worktree cleanups are told, one line per pass rather than a notice a thread.
   */
  noteQuietly(workspaceId: WorkspaceId, note: string): Effect.Effect<void>;
  /**
   * Runs `effect` while the workspace exists and can't be removed: removal waits for it, and one
   * already done makes it `NotFound`. A dream's row and thread are made inside it, so a removal
   * either finds both and closes the thread, or leaves nothing for the dream to start in.
   */
  whileWorkspaceStays<A, E, R>(
    workspaceId: WorkspaceId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NotFound, R>;
  // -- end of Dreams' seam ------------------------------------------------------------------
}

export type WorkspaceStage = NonNullable<WorkspaceState["stages"]>[string];

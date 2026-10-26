import type {
  AgentCapabilities,
  AgentEvent,
  AgentKind,
  AgentModel,
  AgentSessionSummary,
  AgentUnavailable,
  AnswerUndelivered,
  AppToolDescriptor,
  AppToolError,
  ClaudeAiConnector,
  CodexHome,
  ConfiguredServer,
  ConnectorTool,
  InterruptHung,
  McpScope,
  McpServerConfig,
  ModeRefused,
  ModelRef,
  NotFound,
  PermissionMode,
  ProfileId,
  RequestAnswer,
  RequestId,
  SessionPreview,
  SessionTranscript,
  SubscriptionLimitReport,
  ThreadId,
  UserInput,
} from "@gram/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { HelperAdapter } from "./helper.ts";

export interface OpenSessionOptions {
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** Switch target startup only: cancellation/cleanup must never force its child to stop. */
  readonly switchStartup?: string;
  /** The agent's own session id to resume. */
  readonly resumeId?: string;
  /**
   * A deliberate restart on a retired shared Codex child: wait cancellably for that exact child's
   * exit before acquiring a replacement. Ordinary resume keeps its bounded ownership refusal.
   * `onWait` reports the wait without opening a session or sending a provider request.
   */
  readonly waitForPreviousSession?: { readonly onWait: Effect.Effect<void> };
  /** With `resumeId`: continue in a new agent session instead of appending to the original. */
  readonly fork?: boolean;
  /** With `resumeId`: keep the conversation only up to and including this message UUID (rewind). */
  readonly resumeAt?: string;
  /**
   * The id for a new or forked session, so a session that never had a turn keeps its id. Hosts that
   * assign their own ids (Codex) may ignore it; the runtime records whatever id `identity`
   * reports.
   */
  readonly sessionId?: string;
  /**
   * Codex: the `CODEX_HOME` the session to resume or fork lives in, as its `identity` reported it.
   * Absent for a session resumed by id without one, which lives in the user's own home.
   */
  readonly codexHome?: CodexHome;
  readonly model?: ModelRef;
  readonly permissionMode?: PermissionMode;
  readonly appTools?: AppToolRegistryPort;
  /**
   * The thread's app tools over the server's HTTP MCP transport, for agents that can't host them
   * in-process. The bearer token in `headers` binds every call to this thread.
   */
  readonly mcp?: McpEndpoint;
  /** Folders beyond `cwd` the agent may use. */
  readonly additionalDirectories?: ReadonlyArray<string>;
  /** Which app tools the thread's role gives it; absent means `plain`. */
  readonly audience?: ToolAudience;
  /**
   * Standing instructions from the thread's role, added to the agent's own system prompt at every
   * open so they outlive a resume and a compaction. A host that can't carry them ignores them.
   */
  readonly instructions?: string;
  /**
   * Ask before the ordinary ways to push, open, merge or close a PR, whatever allow rules the agent
   * has loaded and whatever permission mode it is in: before all of them (`all`), or only before the
   * ones that can't be taken back (`irreversible`). A boolean is the older spelling: `true` is
   * `all`, and `false`, like leaving it out, is no gate. An accident gate over command spellings,
   * not a boundary: it can't see a push made by another route.
   */
  readonly outwardGate?: boolean | OutwardGate;
  /**
   * Keep the session's unprompted writes inside its `cwd`, with the shell and the network off where
   * the host can't otherwise bound what they write or reach, and no MCP server but Gram's
   * own. What a dream needs: it reads transcripts nobody vetted. A
   * host whose `acceptEdits` already confines writes by itself (Claude by its mode, Codex by the OS
   * sandbox) still drops the user's MCP servers, which neither holds, whatever `mcpAllowlist` says.
   */
  readonly confineWrites?: boolean;
  /** Only the bounded Dream MCP file bridge; no native tools. Unsupported hosts refuse. */
  readonly dreamFilesOnly?: boolean;
  /** Prompt-guided Dream using normal native permissions; never a file-only guarantee. */
  readonly dreamGuided?: boolean;
  /**
   * Keep the agent's shell in `cwd`, so a `cd` lasts one command rather than moving the session. A
   * host whose shell doesn't carry a directory between calls ignores it.
   */
  readonly pinCwd?: boolean;
  /**
   * The only MCP servers the session loads beside Gram's own, each a server's name or a URL
   * pattern (`*` matches anything), which is how a hosted connector is named. Absent, it loads
   * every server the agent is configured with. A host that can't narrow them ignores it.
   */
  readonly mcpAllowlist?: ReadonlyArray<string>;
  /**
   * MCP servers the session leaves out, entries as `mcpAllowlist` takes them; a server both lists
   * name is left out. Gram's own server is never on it. A host that can't leave a server
   * out ignores it, and says so where the set is edited.
   */
  readonly mcpDenylist?: ReadonlyArray<string>;
  /**
   * Take none of the user's MCP servers, as an empty `mcpAllowlist` would, if the session would
   * load every server's tool schemas up front for want of tool search; with tool search the lists
   * apply as given. An orchestrator on its default connectors, which runs unattended and re-reads
   * its tool list all session. A host that can't tell ignores it.
   */
  readonly mcpNoneWithoutToolSearch?: boolean;
  /**
   * Leave out the agent's own tool that holds the turn until the user answers, for a thread that
   * asks through Gram instead. A host without one ignores it.
   */
  readonly noBlockingAsk?: boolean;
  /**
   * Let the session send to the user's other agent sessions outside Gram with the agent's own
   * tools (Claude Code's `ListAgents` and `SendMessage`). Absent, it can't, and no session Gram
   * runs ever takes such a message in, since one would reach the agent past Gram's routing,
   * approval and attribution. A host without such messaging ignores it.
   */
  readonly peerMessaging?: boolean;
  /**
   * Told each time the session reports its MCP servers, so a view with no session open can show
   * the last word. Called synchronously from the agent's message loop: it mustn't block or throw.
   * A host that doesn't report them ignores it.
   */
  readonly onConnectorsSeen?: (seen: ConnectorsSeen) => void;
}

/** One report of a session's MCP servers (`OpenSessionOptions.onConnectorsSeen`). */
export interface ConnectorsSeen {
  /**
   * Everything the agent says of each server, from asking it (Claude's `mcpServerStatus`). False
   * for the names and states a turn's start gives, which say nothing else.
   */
  readonly detailed: boolean;
  /**
   * The session was given every server and connector the user has: no allowlist, no confinement,
   * and the user's own login, so a connector missing from a detailed report is gone.
   */
  readonly whole: boolean;
  readonly connectors: ReadonlyArray<ConnectorStatus>;
}

/**
 * How much of what a thread does outwardly it asks about first. `all` asks before every outward
 * command. `irreversible` lets a push and a new PR through and asks only before a merge, a close, a
 * release, a workflow run, a repo delete, and a push that rewrites or deletes remote history
 * (`outwardKind` draws the line). Read an option's value through `gateLevel`.
 */
export type OutwardGate = "all" | "irreversible";

/**
 * Who a thread is to the app tools: an orchestrator, a worker one spawned, or any other thread.
 * Tools that only make sense for one are bound for that one alone, which also keeps them out of
 * every other agent's context.
 */
export type ToolAudience = "plain" | "orchestrator" | "worker" | "dream";

export interface McpEndpoint {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ConnectorStatus {
  readonly name: string;
  readonly status: "connected" | "failed" | "needs-auth" | "pending" | "disabled";
  readonly error?: string;
  /** Where the connector is configured, e.g. `project`, `user` or `claudeai`. */
  readonly scope?: string;
  /** Where its definition came from, as the agent says: a scope, `plugin` or `sdk`. */
  readonly source?: string;
  /** The server's address, credential-shaped parts masked; a claude.ai connector's upstream one. */
  readonly url?: string;
  /** What it offers, once connected. */
  readonly tools?: ReadonlyArray<ConnectorTool>;
  /** For a claude.ai connector, what claude.ai says of it. */
  readonly claudeAi?: ClaudeAiConnector;
  /** Gram's own app-tools server for the thread; it stays on. */
  readonly builtIn?: boolean;
  /** Why the agent can't reconnect this server live; absent when it can. */
  readonly reconnectUnavailable?: string;
  /** Why this server can't be switched on or off; absent when it can. */
  readonly toggleUnavailable?: string;
  /** What a toggle affects beyond this thread; absent when it only affects this thread. */
  readonly toggleNote?: string;
  /** How to sign in when `authenticate` can't start it for this agent; absent when it can. */
  readonly signInUnavailable?: string;
}

/**
 * A started OAuth sign-in: the page for the caller to open, or `started` when the agent opened the
 * browser itself. The agent receives the callback and keeps the token either way.
 */
export type ConnectorSignInStart = { readonly authorizationUrl: string } | "started";

/** The session's MCP connectors. */
export interface AgentConnectors {
  readonly status: Effect.Effect<ReadonlyArray<ConnectorStatus>, AgentUnavailable>;
  reconnect(name: string): Effect.Effect<void, AgentUnavailable>;
  /** `restart` when the change only applies once the session reopens. */
  setEnabled(
    name: string,
    enabled: boolean,
  ): Effect.Effect<"applied" | "restart", AgentUnavailable>;
  /**
   * Starts the agent's own OAuth sign-in for a server and returns before the user has finished it;
   * `status` reports the outcome. Absent when the agent has no way to start one.
   */
  authenticate?(name: string): Effect.Effect<ConnectorSignInStart, AgentUnavailable>;
  /**
   * The only servers the session took beside Gram's own (`OpenSessionOptions.mcpAllowlist`),
   * so a view can say a server was left out on purpose; absent when it took every one configured.
   */
  readonly allowlist?: ReadonlyArray<string>;
  /** Why the session loads none of the account's claude.ai connectors; absent when it may. */
  readonly claudeAiUnavailable?: string;
  /** The servers the session left out (`OpenSessionOptions.mcpDenylist`); absent when none. */
  readonly denylist?: ReadonlyArray<string>;
}

export interface McpServerPlacement {
  /** The project folder, for a scope that is per project. */
  readonly cwd: string;
  /** One of the agent's own scopes (`MCP_TARGET_SCOPES`). */
  readonly scope: McpScope;
  readonly name: string;
}

export interface ListMcpServersOptions {
  /** A project folder, to include what the agent keeps per project. */
  readonly cwd?: string | undefined;
  /**
   * Ask for sign-in state even when answering makes the agent start and connect every server it
   * has. False: `signedIn` only where the agent knows it without connecting anything.
   */
  readonly checkSignIn: boolean;
}

/**
 * Reads, adds and removes servers in the agent's own MCP config, through the agent where it has a
 * reader or writer. Nothing read is kept, a listing never holds a header or env value, and
 * failures carry a message fit to show, without one either.
 */
export interface AgentMcpConfig {
  add(
    placement: McpServerPlacement,
    config: McpServerConfig,
  ): Effect.Effect<void, AgentUnavailable>;
  remove(placement: McpServerPlacement): Effect.Effect<void, AgentUnavailable>;
  /** The configured servers, with no session open. */
  list(
    options: ListMcpServersOptions,
  ): Effect.Effect<ReadonlyArray<ConfiguredServer>, AgentUnavailable>;
  /**
   * `AgentConnectors.authenticate` with no session open. `cwd` is for an agent whose servers run per
   * folder; it falls back to the user's home.
   */
  signIn(
    name: string,
    cwd: string | undefined,
  ): Effect.Effect<ConnectorSignInStart, AgentUnavailable>;
  /**
   * The name of each server a `signIn` finished signing in to, once the user is done in the
   * browser; the agent's open sessions don't take the token up on their own. For one reader, which
   * runs the waits. Absent when the host can't tell.
   */
  readonly signedIn?: Stream.Stream<string>;
}

/** The reason Gram's app-tools server can't be switched off. */
export const BUILT_IN_TOGGLE_REASON = "Gram's app tools stay on for every thread.";

export interface SendOptions {
  /**
   * A UUID for the user message. Claude records it as the transcript entry's uuid, so it can later
   * anchor `resumeAt`.
   */
  readonly messageId?: string;
}

/** One live agent conversation. Closing the scope passed to `AgentHost.open` ends it. */
export interface AgentSession {
  /**
   * Workspace-switch only. Requests graceful relinquishment and succeeds only after the actual
   * owning child exits. Must refuse held siblings and must never escalate on timeout/cancel.
   * Absent means that this session cannot safely switch harnesses.
   */
  /** Arms exact-child no-force protection without signalling; call before persisting shutdown intent. */
  readonly prepareForSwitch?: Effect.Effect<void, AgentUnavailable>;
  readonly stopForSwitch?: Effect.Effect<void, AgentUnavailable>;
  /** Releases target-startup-only protection after the runtime accepts the new session. */
  readonly acceptSwitchStartup?: (attemptId: string) => Effect.Effect<void, AgentUnavailable>;
  /** Whether a shared provider child still has the current on-disk config; absent if not tracked. */
  readonly configCurrent?: Effect.Effect<boolean>;
  /** Opaque shared-child identity, used only to coordinate config restarts among its holders. */
  readonly configOwner?: object;
  readonly events: Stream.Stream<AgentEvent>;
  /** Starts a turn. The runtime owns the queue and only calls this while idle. */
  send(input: UserInput, options?: SendOptions): Effect.Effect<void>;
  /** Delivers input mid-turn: the current tool finishes, then the agent answers it. */
  steer(input: UserInput): Effect.Effect<void>;
  readonly interrupt: Effect.Effect<void, InterruptHung>;
  /**
   * Closes the session's tool gate, at once: until the turn ends, every tool call is refused before
   * it runs, with `PAUSE_STOP_TEXT`, and the agent ends its turn itself. A call admitted before runs
   * to its end; nothing is interrupted. The turn's end opens it again. Absent for an agent that
   * can't refuse a call before it runs (Codex runs sandboxed commands unasked).
   */
  readonly closeToolGate?: Effect.Effect<void>;
  /**
   * Stops the work the agent left running in the background when its turn ended (Claude's
   * background subagents), and says how many it asked to stop. `interrupt` can't reach these: it
   * aborts a turn, and there is none. Absent for agents with no such thing.
   */
  readonly stopBackgroundTasks?: Effect.Effect<number>;
  /**
   * Stops one of the tasks its `backgroundTasks` events list, and says whether it asked: `false`
   * when no such task is running. Its end arrives as a `backgroundTasks` event without it. Present
   * where `capabilities.stopTasks` is true.
   */
  stopTask?(taskId: string): Effect.Effect<boolean>;
  /**
   * Fails when the answer didn't reach the agent, whose request is then still open and can be
   * answered again; succeeding means the agent has it.
   */
  respond(requestId: RequestId, answer: RequestAnswer): Effect.Effect<void, AnswerUndelivered>;
  /** Fails when the agent won't take the mode, so the caller never records one it isn't in. */
  setMode(mode: PermissionMode): Effect.Effect<void, ModeRefused>;
  setModel(model: ModelRef): Effect.Effect<void>;
  /**
   * Whether running on `model` takes a fresh process rather than a live switch, because what the
   * session was started with depends on it. Absent: every switch is live.
   */
  needsReopenFor?(model: string): boolean;
  /** Present when the agent exposes its MCP connectors. */
  readonly connectors?: AgentConnectors;
  /**
   * Replaces the extra folders of the live session. `false` when the agent can't apply them live
   * and the session has to reopen to pick them up.
   */
  addDirectories?(paths: ReadonlyArray<string>): Effect.Effect<boolean>;
  /** The agent's own OS process when it runs one locally; the root of the thread's port chips. */
  readonly processId?: Effect.Effect<number | undefined>;
}

export interface ListModelsOptions {
  readonly profileId?: ProfileId;
}

export interface AgentHost {
  /** Fresh preparation check for a native login under Gram's outward gate; absent refuses. */
  readonly nativeGateReady?: Effect.Effect<boolean>;
  /** Whether this build/platform offers the opt-in graceful workspace-switch contract. */
  readonly supportsWorkspaceSwitch?: boolean;
  /** Fresh subscription readiness; never treats a cached model catalog as authentication proof. */
  readonly checkWorkspaceSwitch?: Effect.Effect<void, AgentUnavailable>;
  /** Exact-attempt proof: a closed pre-spawn path, or the owned child's actual EXIT. */
  readonly switchAttemptReceipt?: (
    attemptId: string,
  ) => Effect.Effect<"notStarted" | "exited" | undefined>;
  /** Whether the exact attempt has either release proof; unknown/live attempts are false. */
  readonly switchAttemptReleased?: (attemptId: string) => Effect.Effect<boolean>;
  /** Isolated one-shot helpers; mode declares strict tool-free or guided generation. */
  readonly helper?: HelperAdapter;
  readonly kind: AgentKind;
  readonly capabilities: AgentCapabilities;
  /** Read-only CLI-owned subscription query. No gateway profile, inference or helper context. */
  readonly readSubscriptionLimits?: Effect.Effect<
    ReadonlyArray<SubscriptionLimitReport>,
    AgentUnavailable
  >;
  open(options: OpenSessionOptions): Effect.Effect<AgentSession, AgentUnavailable, Scope.Scope>;
  /** The selectable models, for a gateway profile when the agent runs through one. */
  listModels(
    options?: ListModelsOptions,
  ): Effect.Effect<ReadonlyArray<AgentModel>, AgentUnavailable>;
  /**
   * The model ids the agent itself knows through a gateway profile, so the picker can warn about a
   * gateway model it would run on generic settings; `undefined` when it can't say now. Absent when
   * the agent runs any id it is given as it is.
   */
  readonly knownModels?: (profileId: ProfileId) => Effect.Effect<ReadonlySet<string> | undefined>;
  /** Past sessions for `cwd`, newest first. Absent when the agent can't list them. */
  readonly listSessions?: (options: {
    readonly cwd: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<AgentSessionSummary>, AgentUnavailable>;
  /** Deletes one of `listSessions({ cwd })`'s sessions; `NotFound` for any other id. */
  readonly deleteSession?: (options: {
    readonly cwd: string;
    readonly agentSessionId: string;
  }) => Effect.Effect<void, AgentUnavailable | NotFound>;
  /** Present when Gram can write the agent's MCP config through this host. */
  readonly mcpConfig?: AgentMcpConfig;
  /**
   * A gateway profile's key or settings changed: new sessions start on a fresh server, and the old
   * one stops once its sessions have closed. Absent when the host keeps no per-profile servers.
   */
  readonly invalidateProfile?: (profileId: ProfileId) => Effect.Effect<void>;
  /**
   * The agent's executable changed (a managed runtime was updated or rolled back, or the user's own
   * CLI was updated from Settings): new sessions
   * start on a fresh server from the new one, and each old server stops once its sessions have
   * closed. Absent when the host resolves its executable once.
   */
  readonly invalidateRuntime?: Effect.Effect<void>;
  /**
   * A thread on `profileId` (`undefined`, the user's own configuration) is restarting its session to
   * read the agent's setup from disk again. Drops what the host keeps across sessions for it: the
   * resolved executable and environment, and the shared server, which goes on serving the sessions
   * still on it and stops once they close. Absent when the host keeps nothing across sessions.
   */
  readonly reloadConfig?: (profileId: ProfileId | undefined) => Effect.Effect<void>;
  /**
   * The agent's own config changed for every profile: `reloadConfig` for each server it keeps,
   * those no live thread is on included, so the next session on any of them reads the config
   * afresh. Absent when the host keeps no shared servers.
   */
  readonly reloadAllConfig?: Effect.Effect<void>;
  /**
   * The first prompt and last reply of a session in `cwd`, reading only that one session; an empty
   * preview for an id this folder doesn't have.
   */
  readonly previewSession?: (options: {
    readonly cwd: string;
    readonly agentSessionId: string;
  }) => Effect.Effect<SessionPreview, AgentUnavailable>;
  /**
   * A whole past conversation in `cwd`, oldest message first, for history import and dreams: the
   * main conversation only, with tool calls cut to a readable size. `limit` keeps that many
   * messages from the start. `NotFound` for an id this folder doesn't have. Absent when the agent
   * can't read its history back.
   */
  readonly readSession?: (options: {
    readonly cwd: string;
    readonly agentSessionId: string;
    readonly limit?: number;
  }) => Effect.Effect<SessionTranscript, AgentUnavailable | NotFound>;
}

export interface AppTool {
  readonly descriptor: AppToolDescriptor;
  /** Decodes the model's arguments; also the source of the MCP input schema. An object schema. */
  readonly input: Schema.Codec<unknown, unknown>;
  run(input: unknown): Effect.Effect<unknown, AppToolError>;
  /** The approval card's text for a call; `undefined` falls back to the tool's description. */
  describe?(input: unknown): Effect.Effect<string | undefined>;
  /**
   * Whether this call needs an approval card. Absent means the tool's class decides; present, it
   * wins both ways, since who is calling on whom can't be read from a class. The registry's gate
   * is what acts on it. A tool requiring a resolved target fails with AppToolError instead of
   * suggesting approval for an invalid or missing target.
   */
  needsApproval?(input: unknown): Effect.Effect<boolean, AppToolError>;
  /**
   * The one way an *outward* call goes without a card: the user set the workspace's autonomy to
   * `full`, and this call is an orchestrator acting on its own worker. Only an outward tool whose
   * definition names that delegation carries it, `needsApproval` never relaxes the class, and
   * anything but `true` (absent, `false`, a check that dies, input that doesn't decode) is a card.
   */
  delegatedAtFullAutonomy?(input: unknown): Effect.Effect<boolean>;
}

export interface AppToolRegistryPort {
  /** The tools bound to `threadId` with no gate: for their names, and for scripted test calls. */
  forThread(threadId: ThreadId, audience?: ToolAudience): ReadonlyArray<AppTool>;
  /**
   * The tools for a session that serves them in-process (Claude's SDK MCP server), with the
   * registry's approval gate inside `run`, so the host raises no card of its own for them.
   */
  forSession(threadId: ThreadId, audience?: ToolAudience): ReadonlyArray<AppTool>;
}

import { claudeSubscriptionLimits } from "./limits.ts";
import type {
  CanUseTool,
  EffortLevel,
  HookCallbackMatcher,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AgentUnavailable,
  coveredBy,
  fastSelectionProblem,
  InterruptHung,
  MessageId,
  ModeRefused,
  NotFound,
  type AgentCapabilities,
  type AgentEvent,
  type AgentModel,
  type ModelRef,
  type PendingRequest,
  type PermissionMode,
  type RequestId,
  type TokenUsage,
  type UserInput,
} from "@gram/contracts";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomUUID, type UUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { GatewayKeyProvider } from "../gateway.ts";
import {
  acceptChildSwitchStartup,
  endInputAndWait,
  isRunning,
  ownAgentChild,
  protectChildForSwitch,
  stopChildForSwitch,
} from "../child-process.ts";
import type { AgentHost, AgentSession, ConnectorStatus, OpenSessionOptions } from "../host.ts";
import { narrowsMcp, reportedLists, type McpLists } from "../mcp-lists.ts";
import { gateAsks, gateLevel } from "../outward.ts";
import { PAUSE_STOP_TEXT } from "../pause.ts";
import {
  APP_TOOL_SERVER,
  MAIN_AGENT_APP_TOOLS,
  appToolName,
  buildAppToolServer,
} from "./apptools.ts";
import { expectedCliVersion, restoresSessionCost, supportsFastControl } from "./binary.ts";
import {
  makeConnectors,
  nextLapsedConnectors,
  NO_LAPSED_CONNECTORS,
  initServer,
  seenServer,
  toConnectorStatus,
  type SeenServer,
} from "./connectors.ts";
import {
  PEER_MESSAGING_SWITCH,
  REFUSE_PEER_MESSAGES,
  toolSearchOn,
  withPeerMessaging,
} from "./env.ts";
import { ClaudeEnvironment } from "./environment.ts";
import {
  gatewayChildEnv,
  gatewayModelEnv,
  inEuZone,
  redactKey,
  withoutWebSearch,
} from "./gateway-env.ts";
import { AsyncPushQueue } from "./input-queue.ts";
import { advertisedRate } from "./cost-estimate.ts";
import { identityFromInitialization, makeMapper, type TaskOutputRead } from "./mapper.ts";
import { addTokens } from "./usage.ts";
import { toAgentModel, userModelSwitch } from "./models.ts";
import { outwardBashKind, resolveRequest, toPendingRequest } from "./permissions.ts";
import { ClaudeSdk } from "./sdk.ts";
import {
  savedSessionCost,
  toSessionPreview,
  toSessionSummary,
  toSessionTranscript,
} from "./sessions.ts";

/**
 * What a Claude thread supports.
 * - `rewind: "historyAndFiles"`: the adapter rewinds the conversation (`resumeAt` with
 *   `metadata.agentMessageIds`); restoring files comes from the server's per-turn git checkpoints.
 * - `reasoningEffort: true`: `ModelRef.variant` is sent as SDK `effort` on open and applied
 *   mid-session by `setModel`.
 * - `listSessions: true`: the SDK's local transcript listing (`listSessions({ dir })`).
 * - `fork: true`: the server forks lazily with `open({ resumeId, fork: true, resumeAt })`. File
 *   restore on the copied messages is limited, since their checkpoints belong to the source thread.
 */
/** Claude Code's ask tool, which holds the turn until the user answers (`noBlockingAsk`). */
export const BLOCKING_ASK_TOOL = "AskUserQuestion";

/**
 * One `mcpAllowlist` or `mcpDenylist` entry as Claude Code's `allowedMcpServers` and
 * `deniedMcpServers` take it. A hosted claude.ai connector isn't matched by the name Claude Code
 * shows for it ("claude.ai Teams"), only by its URL, so an entry with `://` is a URL pattern and
 * anything else a server's name. Passed as flag settings: Claude Code honours both lists from
 * there, by name and by URL, with the denylist winning (verified on SDK 0.3.292 with a temp home
 * and two local servers), where `managedSettings` is dropped whenever the organisation has a
 * managed tier. Gram's own in-process server needs no entry.
 */
const mcpServerEntry = (entry: string): { serverName: string } | { serverUrl: string } =>
  entry.includes("://") ? { serverUrl: entry } : { serverName: entry };

/**
 * Claude Code's user settings folder for a session's environment: `CLAUDE_CONFIG_DIR`, else
 * `.claude` in the home it is given, `HOME` or, on Windows, where `os.homedir()` looks without one,
 * `USERPROFILE`; `undefined` with none, so nothing else is read.
 */
export const claudeSettingsDir = (env: Readonly<Record<string, string | undefined>>) => {
  const home = env["HOME"] || env["USERPROFILE"];
  return env["CLAUDE_CONFIG_DIR"] || (home ? join(home, ".claude") : undefined);
};

/**
 * What another settings source adds to an allowlist, to be denied: Claude Code unions every
 * source's `allowedMcpServers`, so the user's settings or a repo's `.claude/settings.json` listing a
 * server widens Gram's list to it (measured on SDK 0.3.292: a repo's `beta` beside a flag list of `alpha` loaded both),
 * while `deniedMcpServers` wins over every allowlist. An entry `allowlist` already lets through
 * isn't a widening and stays; one by command or an unknown shape is denied as written.
 */
export const widenedEntries = (
  allowlist: ReadonlyArray<string>,
  added: ReadonlyArray<unknown>,
): ReadonlyArray<Record<string, unknown>> =>
  added.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const as =
      typeof record["serverName"] === "string"
        ? record["serverName"]
        : typeof record["serverUrl"] === "string"
          ? record["serverUrl"]
          : undefined;
    return as !== undefined && coveredBy(allowlist, as) ? [] : [record];
  });

/**
 * The `allowedMcpServers` entries the other settings files Claude Code reads list, for the sources
 * it reads: the user's, under `userDir`, and the folder's own shared and local ones.
 */
const otherAllowlists = async (
  cwd: string,
  userDir: string | undefined,
  sources: ReadonlyArray<SettingSource> | undefined,
): Promise<ReadonlyArray<unknown>> => {
  const files: ReadonlyArray<{ readonly source: SettingSource; readonly path: string }> = [
    ...(userDir === undefined
      ? []
      : [{ source: "user" as const, path: join(userDir, "settings.json") }]),
    { source: "project", path: join(cwd, ".claude", "settings.json") },
    { source: "local", path: join(cwd, ".claude", "settings.local.json") },
  ];
  const found: Array<unknown> = [];
  for (const { source, path } of files) {
    if (sources !== undefined && !sources.includes(source)) continue;
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    try {
      const listed = (JSON.parse(text) as { allowedMcpServers?: unknown }).allowedMcpServers;
      if (Array.isArray(listed)) found.push(...listed);
    } catch {
      // Claude Code drops a settings file it can't parse, and its allowlist with it.
    }
  }
  return found;
};

/** The flag settings that hold a session to `o`'s MCP lists; empty when it names neither. */
const mcpListSettings = (
  o: McpLists,
  widened: ReadonlyArray<Record<string, unknown>> = [],
): {
  allowedMcpServers?: Array<{ serverName: string } | { serverUrl: string }>;
  deniedMcpServers?: Array<Record<string, unknown>>;
} => {
  const denied = [...(o.mcpDenylist ?? []).map(mcpServerEntry), ...widened];
  return {
    ...(o.mcpAllowlist === undefined
      ? {}
      : { allowedMcpServers: o.mcpAllowlist.map(mcpServerEntry) }),
    ...(denied.length === 0 ? {} : { deniedMcpServers: denied }),
  };
};

/**
 * What a session opened with `confineWrites` doesn't get: anything that writes or reaches out
 * without naming a path the permission mode can check, such as an Artifact publish to claude.ai. The file tools stay, and under
 * `acceptEdits` they write unasked only inside the session's folders. Removed from the model's
 * context, not merely denied, so it plans around the file tools instead of asking for a shell.
 */
export const CONFINED_DISALLOWED: ReadonlyArray<string> = [
  "Bash",
  "BashOutput",
  "KillShell",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
  "Artifact",
];

/**
 * What a session opened with `confineWrites` takes of the MCP servers: only Gram's own
 * in-process one, which goes in through `mcpServers`. The user's servers, a project's `.mcp.json`,
 * plugins and claude.ai connectors could each write or reach out where `CONFINED_DISALLOWED` took
 * that away. `strictMcpConfig` is what holds: an empty `allowedMcpServers` alone is unioned with
 * any other settings file's list, a branch's own `.claude/settings.json` included (verified on
 * SDK 0.3.284). The allowlist and the claude.ai opt-out stay as a second layer.
 */
export const CONFINED_MCP = {
  strictMcpConfig: true,
  allowedMcpServers: [],
  env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
} as const;

export const CLAUDE_CAPABILITIES: AgentCapabilities = {
  fork: true,
  rewind: "historyAndFiles",
  steer: true,
  planMode: true,
  approvalScopes: ["once", "session", "always"],
  userQuestions: true,
  costReporting: true,
  perTurnModel: true,
  reasoningEffort: true,
  listSessions: true,
  subagentStreams: true,
  stopTasks: true,
};

export interface ClaudeHostConfig {
  /** `undefined` loads the SDK default (user, project, local), as the CLI does. */
  readonly settingSources?: ReadonlyArray<SettingSource>;
  /** Watchdog for `interrupt()`; the runtime closes and resumes on `InterruptHung`. */
  readonly interruptTimeoutMs?: number;
  /** How long `initializationResult()` may take before `open` fails. */
  readonly startupTimeoutMs?: number;
  /** UUID source for agent session ids and message ids. */
  readonly newId?: () => string;
  /**
   * The claude.ai connectors Claude Code has ever connected, for a session whose child runs with
   * `env`; none when left out, so only what a session sees connect counts.
   */
  readonly readEverConnected?: (
    env: Readonly<Record<string, string>>,
  ) => Promise<ReadonlyArray<string>>;
}

export class ClaudeHost extends Context.Service<ClaudeHost, AgentHost>()(
  "@gram/agents/ClaudeHost",
) {}

/** The prompt text; attachments become `@` mentions, which Claude Code resolves itself. */
export const promptText = (input: UserInput): string => {
  const mentions = (input.attachments ?? []).map((a) =>
    /\s/.test(a.path) ? `@"${a.path}"` : `@${a.path}`,
  );
  return mentions.length ? `${input.text}\n\n${mentions.join(" ")}` : input.text;
};

/** `ModelRef.variant` as SDK effort. `none` sends no effort, so the model's default applies. */
const effortOf = (model: ModelRef | undefined): EffortLevel | undefined =>
  model?.variant === undefined || model.variant === "none" ? undefined : model.variant;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (id: string): id is UUID => UUID_PATTERN.test(id);

const userMessage = (
  input: UserInput,
  options: { readonly priority?: "now"; readonly uuid?: UUID } = {},
): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content: promptText(input) },
  parent_tool_use_id: null,
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
});

interface Pending {
  readonly request: PendingRequest;
  readonly input: Record<string, unknown>;
  readonly settle: (result: PermissionResult) => void;
}

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
};

/** What the outward gate's card says about why it appeared, whatever the mode and rules. */
export const OUTWARD_GATE_REASON =
  "Gram asks before this thread pushes, or opens, merges or closes a pull request, " +
  "whatever its permission mode and allow rules say.";

/** The same, for a thread whose gate lets a push and a new pull request through unasked. */
export const IRREVERSIBLE_GATE_REASON =
  "Gram asks before this thread does what can't be taken back: merging or closing a pull " +
  "request, a release, a workflow run, or a push that rewrites or deletes remote history, " +
  "whatever its permission mode and allow rules say.";

/** A `PreToolUse` hook's answer that sends the call to `canUseTool`, ahead of rules and mode. */
const askFirst = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "ask" as const,
    permissionDecisionReason: reason,
  },
});

/**
 * A `PreToolUse` hook's answer for Gram's own tools, whose gate is inside the tool: the SDK
 * neither asks nor lets its mode, rules or classifier decide.
 */
const APP_TOOL_ALLOWED = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "allow" as const,
    permissionDecisionReason: "Gram's approval gate decides about its own tools.",
  },
};

/** A `PreToolUse` hook's answer for a subagent's call to a tool only the main agent may make. */
const SUBAGENT_DENIED = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason:
      "Only the main agent calls this tool. Return your result to the agent that started you.",
  },
};

/** An explicit address of another session, which a session's own subagents never have. */
const PEER_ADDRESS = /^(?:uds|bridge|did):/;

/**
 * Whether a call would reach another session past Gram (`PEER_MESSAGING_SWITCH`). `ListAgents`
 * always would. `SendMessage` would by an explicit address, and by any name once the switch is
 * seen not to hold, since a peer's name then looks like a subagent's.
 */
const reachesPeer = (toolName: string, toolInput: unknown, switchFailed: boolean): boolean => {
  if (toolName === "ListAgents") return true;
  if (toolName !== "SendMessage") return false;
  if (switchFailed) return true;
  const to = (toolInput as { readonly to?: unknown } | null)?.to;
  return typeof to === "string" && PEER_ADDRESS.test(to.trim());
};

/** A `PreToolUse` hook's answer for a call that would reach another session past Gram. */
const PEER_DENIED = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason:
      "Gram routes messages between sessions. Use its own messaging tools instead.",
  },
};

const CANCELLED: PermissionResult = { behavior: "deny", message: "The request was cancelled." };

/** Why a call is refused while the tool gate is closed (`AgentSession.closeToolGate`). */
export const TOOL_GATE_REASON = PAUSE_STOP_TEXT;

/** A `PreToolUse` hook's answer while the tool gate is closed. */
const GATE_CLOSED = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason: TOOL_GATE_REASON,
  },
};

/**
 * The tool gate behind `closeToolGate`, on the adapter's own thread: once closed, `PreToolUse`
 * refuses every call, and `close` resolves when no call admitted before is unfinished, or the turn
 * ends. A turn's end opens it. Nothing interrupts the turn: the agent ends it.
 */
export const makeToolGate = () => {
  const admitted = new Set<string>();
  let open = true;
  const waiters: Array<() => void> = [];
  const settle = () => {
    if (open || admitted.size > 0) return;
    for (const resolve of waiters.splice(0)) resolve();
  };
  return {
    /** A call reaching `PreToolUse`: `false` refuses it. */
    admit: (toolUseId: string | undefined): boolean => {
      if (!open) return false;
      if (toolUseId !== undefined) admitted.add(toolUseId);
      return true;
    },
    /** An admitted call finished, failed or was refused after all. */
    finished: (toolUseId: string | undefined): void => {
      if (toolUseId === undefined || !admitted.delete(toolUseId)) return;
      settle();
    },
    /** Closes it; resolves once nothing admitted is unfinished. */
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        open = false;
        waiters.push(resolve);
        settle();
      }),
    /** The turn ended: nothing it admitted still runs, and the next turn may call tools again. */
    turnEnded: (): void => {
      admitted.clear();
      const waiting = waiters.splice(0);
      open = true;
      for (const resolve of waiting) resolve();
    },
    get open() {
      return open;
    },
  };
};

/** How often a running shell command's output is read back, foreground or background. */
export const SHELL_OUTPUT_POLL_MS = 1_000;
/** How long one read may take before it counts as unanswered. */
export const SHELL_OUTPUT_READ_TIMEOUT_MS = 5_000;
/** Unanswered reads in a row after which a task counts as one the CLI won't read. */
export const SHELL_OUTPUT_TIMEOUTS = 3;
/** How long a closing session gives the turn under way to end on an interrupt and report it. */
const CLOSE_INTERRUPT_MS = 1_500;
/**
 * How long a closing session waits for its CLI to save and exit once its input ends, before the
 * SDK's `close` SIGTERMs it 2 s later. With `CLOSE_INTERRUPT_MS`, within the shutdown's 4 s for
 * the sessions.
 */
const CLOSE_EXIT_MS = 2_000;

type ShellRead =
  | { readonly kind: "answer"; readonly value: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "refused" };

/**
 * `Query.getTaskOutput`: the `get_task_output` control request (`SDKControlGetTaskOutputRequest`
 * in SDK 0.3.296's `sdk.d.ts`, "a host polls it while the task runs"). The SDK's `sdk.mjs` has the
 * method, but its `Query` type leaves it out, so it is looked up rather than called.
 */
const taskOutputReader = (q: object): ((taskId: string) => Promise<unknown>) | undefined => {
  const method: unknown = Reflect.get(q, "getTaskOutput");
  return typeof method === "function"
    ? (taskId) => Promise.resolve(method.call(q, taskId) as unknown)
    : undefined;
};

const isTaskOutputRead = (u: unknown): u is TaskOutputRead =>
  typeof u === "object" &&
  u !== null &&
  typeof Reflect.get(u, "output") === "string" &&
  typeof Reflect.get(u, "total_bytes") === "number" &&
  typeof Reflect.get(u, "truncated") === "boolean";

/** A prompt that never sends, so a query only runs the CLI's init handshake. */
/** How long the account's model listing stands before `listModels` asks Claude Code again. */
export const MODELS_TTL_MS = 5 * 60_000;

const silentPrompt: AsyncIterable<SDKUserMessage> = {
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
};

export const makeClaudeHost = (
  config: ClaudeHostConfig = {},
): Effect.Effect<AgentHost, never, ClaudeSdk | ClaudeEnvironment> =>
  Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    const environment = yield* ClaudeEnvironment;
    // Optional: without it, a thread on a gateway profile can't open.
    const gatewayKeys = yield* Effect.serviceOption(GatewayKeyProvider);
    const newId = config.newId ?? randomUUID;
    const interruptTimeoutMs = config.interruptTimeoutMs ?? 5_000;
    const startupTimeoutMs = config.startupTimeoutMs ?? 30_000;
    /**
     * What sessions have learned a model costs, for the next session's first-turn estimate. Kept per
     * profile: a gateway may price the same model id differently from the subscription.
     */
    const learnedRates = new Map<string, Map<string, number>>();

    const releasedSwitches = new Set<string>();
    const switchAttempts = new Map<
      string,
      { allowSpawn: boolean; spawned: boolean; notStarted: boolean }
    >();
    const openSession = Effect.fnUntraced(function* (o: OpenSessionOptions) {
      if (o.dreamFilesOnly === true) o = { ...o, confineWrites: true };
      if (o.dreamFilesOnly === true && o.audience === "dream" && o.appTools === undefined)
        return yield* new AgentUnavailable({
          agent: "claude",
          reason: "startup-failed",
          message: "Dream file bridge is unavailable; no session was started",
        });
      const prepared = yield* environment.prepare;
      // A thread on a gateway profile runs `claude` against the gateway with the user's key, so the
      // subscription guard doesn't apply to it; every other thread keeps the guard.
      const profileId = o.model?.profileId;
      const gateway =
        profileId === undefined
          ? undefined
          : yield* Option.match(gatewayKeys, {
              onNone: () =>
                Effect.fail(
                  new AgentUnavailable({
                    agent: "claude",
                    message: "Gateway profiles aren't available in this build.",
                  }),
                ),
              onSome: (provider) => provider.credentials(profileId, "claude"),
            });
      if (gateway === undefined) yield* environment.checkAuth(prepared);
      // A profile without models would hand `claude` an empty model id.
      if (gateway !== undefined && (o.model?.model ?? "").trim() === "") {
        return yield* new AgentUnavailable({
          agent: "claude",
          message: `Pick a model for ${gateway.profile.name}: the profile has none yet. Discover models in Settings → Gateways.`,
        });
      }
      const childEnv =
        gateway === undefined
          ? prepared.env
          : gatewayChildEnv(
              prepared.env,
              gateway.profile.baseURL,
              gateway.key,
              gatewayModelEnv(gateway.profile.models, o.model?.model),
            );
      // Without tool search every schema of every server would sit in the context all session.
      const noToolSearch = o.mcpNoneWithoutToolSearch === true && !toolSearchOn(childEnv);
      const lists: OpenSessionOptions = noToolSearch ? { ...o, mcpAllowlist: [] } : o;
      // Narrowed by either list, the session's listing is a part of the account's catalogue.
      const whole = gateway === undefined && o.confineWrites !== true && !narrowsMcp(lists);
      const seen = (detailed: boolean, connectors: ReadonlyArray<ConnectorStatus>) =>
        o.onConnectorsSeen?.({ detailed, whole, connectors });
      // Claude Code's Bash keeps the directory a `cd` left it in for the rest of the session; this
      // puts it back in the project folder after every command.
      const env = {
        ...(o.peerMessaging === true ? withPeerMessaging(childEnv) : childEnv),
        ...(o.pinCwd === true ? { CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1" } : {}),
        ...(o.confineWrites === true ? CONFINED_MCP.env : {}),
      };
      // Another source's allowlist would widen the session's, so what it adds is denied
      // (`widenedEntries`).
      const widened =
        o.confineWrites !== true && lists.mcpAllowlist !== undefined
          ? widenedEntries(
              lists.mcpAllowlist,
              yield* Effect.promise(() =>
                otherAllowlists(o.cwd, claudeSettingsDir(env), config.settingSources),
              ),
            )
          : [];
      // WebSearch is read once, for the model the session opens on; `needsReopenFor` reopens the
      // session on a switch across the EU boundary, the only kind that changes it.
      const disallowedTools = [
        ...new Set([
          ...(o.confineWrites === true ? CONFINED_DISALLOWED : []),
          ...(o.noBlockingAsk === true ? [BLOCKING_ASK_TOOL] : []),
          ...(gateway !== undefined && withoutWebSearch(gateway.profile.models, o.model?.model)
            ? ["WebSearch"]
            : []),
        ]),
      ];

      const events = yield* Queue.unbounded<AgentEvent, Cause.Done>();
      const emit = (event: AgentEvent): void => {
        Queue.offerUnsafe(events, event);
      };
      const rates = learnedRates.get(profileId ?? "") ?? new Map<string, number>();
      learnedRates.set(profileId ?? "", rates);
      // Claude Code carries a resumed or forked session's cost on from its transcript, and the
      // server adds a thread's sessions up, so the mapper takes the carried total back off.
      const readTranscript = sdk.importSessionToStore;
      const resumeId = o.resumeId;
      const runningCli =
        prepared.sdkExecutable === undefined
          ? expectedCliVersion(sdk.version)
          : prepared.cliVersion;
      const carriedCost =
        resumeId === undefined || readTranscript === undefined || !restoresSessionCost(runningCli)
          ? 0
          : yield* Effect.tryPromise(() => savedSessionCost(readTranscript, resumeId, o.cwd)).pipe(
              // An unreadable transcript is one the CLI can't resume from either.
              Effect.orElseSucceed(() => 0),
            );
      const mapper = makeMapper({
        newMessageId: () => MessageId.make(newId()),
        rates,
        carriedCost,
      });
      // Connectors that used to work and need signing in again, from each init and status read.
      let lapsed = NO_LAPSED_CONNECTORS;
      let everConnected: ReadonlySet<string> = new Set();
      /** The latest listing, judged again once the remembered names are in. */
      let lastListed: ReadonlyArray<SeenServer> = [];
      const observeConnectors = (servers: ReadonlyArray<SeenServer>): void => {
        lastListed = servers;
        const next = nextLapsedConnectors(lapsed, servers, everConnected);
        const changed = next.lapsed.join("\n") !== lapsed.lapsed.join("\n");
        lapsed = next;
        if (changed) emit({ type: "connectorsLapsed", names: next.lapsed });
      };
      void (config.readEverConnected?.(env) ?? Promise.resolve([])).then(
        (names) => {
          everConnected = new Set(names);
          // An init may have come before the read finished.
          if (names.length > 0) observeConnectors(lastListed);
        },
        // Unreadable is the same as a Claude Code that remembers none: only this session counts.
        () => undefined,
      );
      const input = new AsyncPushQueue<SDKUserMessage>();
      const pending = new Map<RequestId, Pending>();
      const stderr: Array<string> = [];
      const appServer = o.appTools
        ? buildAppToolServer(o.threadId, o.appTools, sdk, o.audience)
        : undefined;
      let endedReason: string | undefined;
      let effort = effortOf(o.model);
      let speed = o.model?.speed;
      if (o.model?.speed === "fast") {
        const problem = fastSelectionProblem(
          o.model,
          o.model.profileId === undefined ? yield* listModels : [],
        );
        if (problem !== undefined)
          return yield* new AgentUnavailable({ agent: "claude", message: problem });
      }
      const reportSpeed = (report: {
        fast_mode_state?: string;
        fast_mode_disabled_reason?: string;
      }) => {
        const state = report.fast_mode_state;
        emit({
          type: "speed",
          state: {
            speed:
              state === "on" && report.fast_mode_disabled_reason === undefined
                ? "fast"
                : state === "off" ||
                    state === "cooldown" ||
                    report.fast_mode_disabled_reason !== undefined
                  ? "standard"
                  : "unknown",
            ...(report.fast_mode_disabled_reason !== undefined
              ? { detail: `Claude Fast unavailable: ${report.fast_mode_disabled_reason}` }
              : state === "cooldown"
                ? { detail: "Claude Fast is cooling down; requests use Standard." }
                : {}),
          },
        });
      };

      // Where the main agent is working, so the thread can follow it into another worktree: after a
      // tool call that moved it, and at every turn end. Subagent excursions don't count.
      let reportedCwd = o.cwd;
      const reportCwd: HookCallbackMatcher["hooks"][number] = async (hookInput) => {
        if (hookInput.agent_id !== undefined) return {};
        if (hookInput.hook_event_name === "Stop" || hookInput.cwd !== reportedCwd) {
          reportedCwd = hookInput.cwd;
          emit({ type: "cwd", cwd: hookInput.cwd });
        }
        return {};
      };

      // A `/model` typed into the thread switches the session without going through `setModel`, so
      // the thread would keep naming the model it was opened with.
      const reportModel: HookCallbackMatcher["hooks"][number] = async (hookInput) => {
        // Every main-loop switch, our own `setModel` and a fallback included: the context meter
        // picks the running model's `modelUsage` entry by the variant tag only this id carries.
        if (hookInput.hook_event_name === "PostModelSwitch" && hookInput.agent_id === undefined) {
          mapper.setSessionModel(hookInput.to_model);
        }
        const model = userModelSwitch(hookInput);
        if (model !== undefined) emit({ type: "model", model });
        return {};
      };

      // The summary a compaction leaves the main agent with, for the transcript's marker.
      const reportCompaction: HookCallbackMatcher["hooks"][number] = async (hookInput) => {
        if (hookInput.hook_event_name === "PostCompact" && hookInput.agent_id === undefined) {
          for (const event of mapper.compacted(hookInput.compact_summary)) emit(event);
        }
        return {};
      };
      // Who started the compaction under way, which its `compacting` status doesn't say.
      const reportCompacting: HookCallbackMatcher["hooks"][number] = async (hookInput) => {
        if (hookInput.hook_event_name === "PreCompact" && hookInput.agent_id === undefined) {
          for (const event of mapper.compacting(hookInput.trigger)) emit(event);
        }
        return {};
      };

      // The outward gate. A hook runs ahead of the loaded allow
      // rules and of the permission mode, and its "ask" is what sends the call to `canUseTool`:
      // an allow rule such as `Bash(git *)` is otherwise decided before `canUseTool` is asked, and
      // `bypassPermissions` doesn't ask at all. Verified live in every mode on SDK 0.3.272.
      // Subagents' calls are gated too, so there is no `agent_id` filter here.
      //
      // Gram's own tools are the exception, let through here in every mode: the registry's
      // gate inside each tool is what asks about them, with the same rules as for
      // every other agent. The SDK's own layer could only be skipped (by `bypassPermissions`, an
      // allow rule, an "always" answer, or Auto's classifier) or ask a second time, so it doesn't
      // get a say; a deny rule still outranks a hook's "allow".
      //
      // The gate is levelled: at `irreversible` a push and a new PR get an empty answer here, which
      // leaves them to the mode and the rules like any other command.
      //
      // `o.confineWrites` takes the shell, the network and subagents away (`CONFINED_DISALLOWED`
      // below): `acceptEdits` does confine an unasked edit to the session's folders, but it asks
      // about the shell, and a dream that reached for `find … | xargs … && cat` to read its inputs
      // stopped on a card five seconds into a live run, with nobody watching to answer it.
      const level = gateLevel(o.outwardGate);
      const gateAsksAbout = (toolName: string, toolInput: unknown): boolean =>
        gateAsks(level, outwardBashKind(toolName, toolInput));
      const isAppTool = (toolName: string): boolean => appServer?.names.has(toolName) ?? false;
      // A hook, not a deny rule: a rule would take the tool from the main agent too.
      const mainAgentOnly = new Set([...MAIN_AGENT_APP_TOOLS].map(appToolName));
      const toolGate = makeToolGate();
      // Claude Code's peer messaging is off by the env switch alone; a CLI that dropped or renamed
      // it would still list `ListAgents` at init, and from then on every send is refused here.
      const peerAllowed = o.peerMessaging === true;
      const peerSwitchSet =
        (env as Record<string, string | undefined>)[PEER_MESSAGING_SWITCH] === "0";
      let peerSwitchFailed = false;
      const gateCalls: HookCallbackMatcher["hooks"][number] = async (hookInput, toolUseId) => {
        if (hookInput.hook_event_name !== "PreToolUse") return {};
        // Before every other answer: a closed gate refuses even Gram's own tools.
        if (!toolGate.admit(toolUseId ?? hookInput.tool_use_id)) return GATE_CLOSED;
        if (isAppTool(hookInput.tool_name)) {
          return hookInput.agent_id !== undefined && mainAgentOnly.has(hookInput.tool_name)
            ? SUBAGENT_DENIED
            : APP_TOOL_ALLOWED;
        }
        if (
          !peerAllowed &&
          reachesPeer(hookInput.tool_name, hookInput.tool_input, peerSwitchFailed)
        ) {
          toolGate.finished(toolUseId ?? hookInput.tool_use_id);
          return PEER_DENIED;
        }
        if (o.dreamFilesOnly === true) {
          toolGate.finished(toolUseId ?? hookInput.tool_use_id);
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: "Dream may use only its bounded file bridge",
            },
          };
        }
        if (gateAsksAbout(hookInput.tool_name, hookInput.tool_input)) {
          return askFirst(level === "all" ? OUTWARD_GATE_REASON : IRREVERSIBLE_GATE_REASON);
        }
        return {};
      };
      const gated = level !== undefined || appServer !== undefined || o.dreamFilesOnly === true;
      // An admitted call ends here however it ends: run, failed, or refused by a rule or a card.
      const toolEnded: HookCallbackMatcher["hooks"][number] = async (hookInput, toolUseId) => {
        if (
          hookInput.hook_event_name === "PostToolUse" ||
          hookInput.hook_event_name === "PostToolUseFailure" ||
          hookInput.hook_event_name === "PermissionDenied"
        ) {
          toolGate.finished(toolUseId ?? hookInput.tool_use_id);
        }
        return {};
      };

      /** Set once the scope closes, so a card still being raised is denied instead. */
      let closed = false;
      const canUseTool: CanUseTool = (toolName, toolInput, { signal, ...options }) =>
        new Promise<PermissionResult>((resolve) => {
          if (signal.aborted) return resolve(CANCELLED);
          // Reached only if an "ask" rule outranks the hook's "allow"; the tool's gate still asks.
          if (isAppTool(toolName)) return resolve({ behavior: "allow", updatedInput: toolInput });
          if (o.dreamFilesOnly === true)
            return resolve({
              behavior: "deny",
              message: "Dream may use only its bounded file bridge",
            });
          if (closed) return resolve({ behavior: "deny", message: "The session was closed." });
          const request = toPendingRequest(
            toolName,
            toolInput,
            options,
            // "Always" would write an allow rule, and the gate's hook asks again whatever the
            // rules say.
            gateAsksAbout(toolName, toolInput),
          );
          const settle = (result: PermissionResult) => {
            if (!pending.delete(request.id)) return;
            signal.removeEventListener("abort", onAbort);
            emit({ type: "requestResolved", requestId: request.id });
            resolve(result);
          };
          const onAbort = () => settle(CANCELLED);
          signal.addEventListener("abort", onAbort, { once: true });
          pending.set(request.id, { request, input: toolInput, settle });
          emit({ type: "request", request });
          emit({
            type: "status",
            status: request.kind === "approval" ? "awaitingApproval" : "awaitingInput",
          });
        });

      // Our own id for new sessions and forks, so identity is known before the first turn.
      const agentSessionId =
        o.resumeId !== undefined && o.fork !== true ? o.resumeId : (o.sessionId ?? newId());
      let processId: number | undefined;
      let ownedChild: ChildProcess | undefined;
      let acceptSwitchStartup: (() => void) | undefined;
      // What the CLI's own exit says once its input ends: it runs on through a turn under way,
      // and exits 1 when its last result was an error, else 0 (Claude Code 2.1.299). Exit 1 is
      // expected only on an error result read for the latest turn: a turn starting clears the
      // last one's, so a crash (exit 1) after an interrupt that reported no result isn't orderly.
      let turnRunning = false;
      let resultFailed: boolean | undefined;
      const turnStarts = (): void => {
        turnRunning = true;
        resultFailed = undefined;
      };
      const observeTurn = (message: SDKMessage, continues: boolean): void => {
        if (message.type === "result") {
          resultFailed = message.is_error;
          turnRunning = continues;
        } else if (message.type === "system" && message.subtype === "session_state_changed") {
          if (message.state === "idle") turnRunning = false;
          else if (!turnRunning) turnStarts();
        }
      };
      let initialized = false;
      // Set once the pump reads: what the CLI says after the pump stopped, to the turn's end.
      let readToTurnEnd: (() => Promise<void>) | undefined;
      const executable = prepared.sdkExecutable;
      const options: Options = {
        ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
        env,
        cwd: o.cwd,
        // The SDK's default spawn, plus the child's pid for port chips. A custom spawn takes over
        // stderr, so it's forwarded to `stderr` below.
        spawnClaudeCodeProcess: ({ command, args, cwd, env: spawnEnv, signal }) => {
          const attempt =
            o.switchStartup === undefined ? undefined : switchAttempts.get(o.switchStartup);
          if (attempt !== undefined) {
            if (!attempt.allowSpawn || attempt.spawned)
              throw new Error("This switch attempt no longer permits a child to start.");
            // Before spawn: an exception from spawn is unknown ownership, never fabricated no-child proof.
            attempt.spawned = true;
          }
          const child = spawn(command, args, {
            cwd,
            env: spawnEnv,
            signal,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          processId = child.pid;
          ownedChild = child;
          // The session's close ends it; an update attests that it has (`stopOwnedAgentsForUpdate`).
          ownAgentChild(child, "session", () =>
            turnRunning ? undefined : resultFailed === true ? 1 : 0,
          );
          if (o.switchStartup !== undefined)
            child.once("exit", () => releasedSwitches.add(o.switchStartup!));
          if (o.switchStartup) acceptSwitchStartup = protectChildForSwitch(child);
          child.stderr.setEncoding("utf8").on("data", (data: string) => options.stderr?.(data));
          return child;
        },
        includePartialMessages: true,
        forwardSubagentText: true,
        canUseTool,
        hooks: {
          // The tool gate (`closeToolGate`) rides on the same hook, so it is there only where that is.
          ...(gated
            ? {
                PreToolUse: [{ hooks: [gateCalls] }],
                PostToolUse: [{ hooks: [reportCwd, toolEnded] }],
                PostToolUseFailure: [{ hooks: [toolEnded] }],
                PermissionDenied: [{ hooks: [toolEnded] }],
              }
            : { PostToolUse: [{ hooks: [reportCwd] }] }),
          Stop: [{ hooks: [reportCwd] }],
          PostModelSwitch: [{ hooks: [reportModel] }],
          PreCompact: [{ hooks: [reportCompacting] }],
          PostCompact: [{ hooks: [reportCompaction] }],
        },
        stderr: (data) => {
          stderr.push(
            ...data
              .split("\n")
              .filter((line) => line.trim() !== "")
              .map((line) => redactKey(line, gateway?.key)),
          );
          stderr.splice(0, Math.max(0, stderr.length - 20));
        },
        ...(o.dreamFilesOnly === true
          ? { settingSources: [] }
          : config.settingSources === undefined
            ? {}
            : { settingSources: [...config.settingSources] }),
        // Agent SDK 0.3.286 leaves an omitted mode to Claude Code, which starts a gateway session
        // in auto mode, decided by its classifier instead of by `canUseTool`.
        permissionMode: o.permissionMode ?? "default",
        // Claude Code only lets a session into `bypassPermissions` if it launched in that mode or
        // with this flag: without it, picking Bypass on a live thread is refused ("the session was
        // not launched with --dangerously-skip-permissions") and the agent keeps asking. The flag
        // only makes the mode available; nothing bypasses until the user picks it.
        allowDangerouslySkipPermissions: true,
        ...(o.model === undefined ? {} : { model: o.model.model }),
        ...(effort === undefined ? {} : { effort }),
        ...(o.resumeId === undefined
          ? { sessionId: agentSessionId }
          : o.fork === true
            ? { resume: o.resumeId, forkSession: true, sessionId: agentSessionId }
            : { resume: o.resumeId }),
        ...(o.resumeId !== undefined && o.resumeAt !== undefined
          ? { resumeSessionAt: o.resumeAt }
          : {}),
        ...(appServer === undefined ? {} : { mcpServers: { [APP_TOOL_SERVER]: appServer.config } }),
        ...(o.additionalDirectories === undefined
          ? {}
          : { additionalDirectories: [...o.additionalDirectories] }),
        ...(o.dreamFilesOnly === true ? { tools: [] } : {}),
        ...(disallowedTools.length === 0 ? {} : { disallowedTools }),
        ...(o.confineWrites === true ? { strictMcpConfig: CONFINED_MCP.strictMcpConfig } : {}),
        settings: {
          // Confinement outranks an allowlist: an exception for a confined session is its own
          // decision.
          ...(o.confineWrites === true
            ? { allowedMcpServers: [...CONFINED_MCP.allowedMcpServers] }
            : mcpListSettings(lists, widened)),
          ...(speed === undefined ? {} : { fastMode: speed === "fast" }),
          // A peer session's message would reach the agent past Gram's routing and fence.
          ...REFUSE_PEER_MESSAGES,
        },
        // Claude Code's own prompt, plus the thread's role prompt if it has one. Omitting the option
        // isn't the CLI default: the SDK sends an empty custom prompt, and the model gets a
        // 136-character system prompt instead of the ~27k one a terminal session gets (SDK 0.3.284,
        // CLI 2.1.286). `snapshot: false` because the default records the first value in the
        // transcript and replays it on every resume, so a changed or withdrawn role prompt would
        // never take effect (verified on SDK 0.3.272), nor would this fix reach a thread that
        // recorded the empty prompt.
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(o.instructions === undefined ? {} : { append: o.instructions }),
          snapshot: false,
        },
      };

      // The CLI ended as its own protocol ends it, so it saves its session and exits by itself
      // rather than to the SIGTERM `close` sends a CLI still running 2 s on: a turn under way is
      // interrupted and its result read, then the input ends. One that does neither in time is
      // left to `close`, and an update's shutdown check takes that exit as not orderly.
      const stopCli = (query: Query) =>
        Effect.gen(function* () {
          const child = ownedChild;
          if (!initialized || child === undefined || !isRunning(child)) return;
          if (turnRunning) {
            yield* Effect.tryPromise(() => query.interrupt().then(() => readToTurnEnd?.())).pipe(
              Effect.ignore,
              Effect.timeoutOption(CLOSE_INTERRUPT_MS),
            );
          }
          yield* Effect.promise(() => endInputAndWait(child, CLOSE_EXIT_MS));
        });

      const q = yield* Effect.acquireRelease(
        Effect.sync(() => sdk.query({ prompt: input, options })),
        (query) =>
          Effect.gen(function* () {
            closed = true;
            for (const p of pending.values()) {
              p.settle({ behavior: "deny", message: "The session was closed." });
            }
            input.end();
            yield* stopCli(query);
            query.close();
            Queue.endUnsafe(events);
          }),
      );

      const init = yield* Effect.tryPromise(() => q.initializationResult()).pipe(
        Effect.timeoutOrElse({
          duration: startupTimeoutMs,
          orElse: () => Effect.fail(new Error(`no response within ${startupTimeoutMs} ms`)),
        }),
        Effect.mapError((error) => {
          // A spawn in a folder that is gone fails with ENOENT, which the SDK words as its binary
          // failing to launch: a merged worker's worktree, removed after its PR landed.
          const cwdGone =
            /failed to launch|ENOENT/.test(describeError(error)) && !existsSync(o.cwd);
          const detail = cwdGone
            ? `the thread's folder no longer exists: ${o.cwd}`
            : `${describeError(error)}${stderr.length ? `\n${stderr.join("\n")}` : ""}`;
          return new AgentUnavailable({
            agent: "claude",
            // `--resume` of an id that never got a transcript; the runtime opens it fresh instead.
            reason:
              o.resumeId !== undefined && /No conversation found/i.test(detail)
                ? "session-not-found"
                : "startup-failed",
            message: `Claude Code didn't start: ${detail}`,
          });
        }),
      );

      initialized = true;
      for (const warning of prepared.warnings) {
        emit({ type: "notice", level: "warning", message: warning });
      }
      const identity = identityFromInitialization(init, {
        agentSessionId,
        model: o.model?.model ?? "default",
      });
      mapper.setCommands(init.commands);
      const advertise = (picked: string): void =>
        mapper.setAdvertisedRate(
          advertisedRate(init.models.find((m) => m.value === picked)?.description),
        );
      advertise(o.model?.model ?? "default");
      emit(identity);
      emit({ type: "status", status: "idle" });

      // Background tasks still running, by the SDK's task id, which is what `stopTask` takes. The
      // mapper tracks the same tasks by tool-use id, for the transcript; this is the handle to stop
      // one, kept here because only the session holds the query.
      const backgroundTasks = new Set<string>();
      // CLI 2.1.286 returns an aborted result before continuing a priority-now input.
      // That result ends an SDK iteration, not the logical turn the runtime is still following.
      let steers = 0;
      let continuingSteer = false;
      if (init.fast_mode_state !== undefined || speed !== undefined) reportSpeed(init);

      let continuationDeadline: number | undefined;
      let carriedTokens: TokenUsage | undefined;
      let iterationTokens: TokenUsage | undefined;
      let resultlessIdle = false;
      const carryUsage = (): void => {
        if (iterationTokens !== undefined) {
          carriedTokens =
            carriedTokens === undefined
              ? iterationTokens
              : addTokens(carriedTokens, iterationTokens);
        }
        iterationTokens = undefined;
      };
      const resetUsage = (): void => {
        carriedTokens = undefined;
        iterationTokens = undefined;
        resultlessIdle = false;
      };
      const trackBackgroundTask = (message: SDKMessage) => {
        if (message.type !== "system") return;
        if (message.subtype === "background_tasks_changed") {
          // The level also has the shells the CLI moved to the background itself.
          backgroundTasks.clear();
          for (const task of message.tasks)
            if (task.ambient !== true) backgroundTasks.add(task.task_id);
        } else if (message.subtype === "task_started" && message.is_backgrounded === true) {
          backgroundTasks.add(message.task_id);
        } else if (message.subtype === "task_notification") {
          backgroundTasks.delete(message.task_id);
        }
      };

      const onMessage = (message: SDKMessage): void => {
        if ("fast_mode_state" in message || "fast_mode_disabled_reason" in message)
          reportSpeed(message);
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          gateway === undefined &&
          message.apiKeySource !== "none"
        ) {
          endedReason = "api-key-auth";
          emit({ type: "status", status: "error" });
          emit({
            type: "notice",
            level: "error",
            message: `Claude Code is using API-key auth (${message.apiKeySource}); Gram requires your subscription login.`,
          });
          q.close();
          return;
        }
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          peerSwitchSet &&
          !peerSwitchFailed &&
          Array.isArray(message.tools) &&
          message.tools.includes("ListAgents")
        ) {
          peerSwitchFailed = true;
          emit({
            type: "notice",
            level: "warning",
            message: `Claude Code ${runningCli ?? "(version unknown)"} kept its cross-session messaging on despite ${PEER_MESSAGING_SWITCH}=0. Gram refuses ListAgents and SendMessage in this session.`,
          });
        }
        trackBackgroundTask(message);
        // Guarded, since a throw here would end the session over a report nobody needs.
        if (
          message.type === "system" &&
          message.subtype === "init" &&
          Array.isArray(message.mcp_servers)
        ) {
          observeConnectors(message.mcp_servers);
          seen(false, message.mcp_servers.flatMap(initServer));
        }
        const terminal = message.type === "result" ? message.terminal_reason : undefined;
        const continues =
          (steers > 0 || continuingSteer) &&
          (terminal === "aborted_tools" || terminal === "aborted_streaming");
        observeTurn(message, continues);
        if (message.type === "result") {
          steers = 0;
          continuingSteer = continues;
          // A late result after a result-less idle still describes the same SDK iteration.
          resultlessIdle = false;
        }
        for (const event of mapper.map(message)) {
          if (
            event.type === "turnEnd" &&
            (continues ||
              ((steers > 0 || continuingSteer) &&
                message.type === "system" &&
                message.subtype === "session_state_changed" &&
                message.state === "idle"))
          ) {
            if (!continues) {
              steers = 0;
              continuingSteer = true;
              resultlessIdle = true;
            }
            continue;
          }
          if ((steers > 0 || continuingSteer) && event.type === "status" && event.status === "idle")
            continue;
          if (event.type === "turnEnd") toolGate.turnEnded();
          if (
            event.type === "chunk" &&
            event.chunk.type === "start" &&
            event.chunk.messageMetadata?.parentToolUseId === undefined
          ) {
            if (resultlessIdle) carryUsage();
            resultlessIdle = false;
            continuingSteer = false;
          }
          if (event.type === "usage") {
            iterationTokens = event.tokens;
            // Cost is already session-cumulative and context belongs to the latest request.
            emit({
              ...event,
              tokens:
                carriedTokens === undefined ? event.tokens : addTokens(carriedTokens, event.tokens),
            });
          } else {
            emit(event);
            if (event.type === "turnEnd") resetUsage();
          }
        }
        if (continues) carryUsage();
      };

      const iterator = q[Symbol.asyncIterator]();
      // A continuation timeout leaves the read in flight: its next message must not be discarded
      // or overtaken by another iterator.next() call.
      let pendingNext: Promise<IteratorResult<SDKMessage, void>> | undefined;
      // Only once the pump has stopped, so this is the iterator's one reader.
      readToTurnEnd = async () => {
        // `observeTurn` clears `turnRunning` once the turn's result is read.
        while (true) {
          if (!turnRunning) return;
          const next = await (pendingNext ??= iterator.next());
          pendingNext = undefined;
          if (next.done === true) return;
          observeTurn(next.value, false);
        }
      };
      // Interrupting this must not wait for `next()`: it only settles once the query closes, and
      // the scope closes the query after interrupting the pump.
      const nextMessage = Effect.callback<IteratorResult<SDKMessage, void>, unknown>((resume) => {
        pendingNext ??= iterator.next();
        pendingNext.then(
          (result) => resume(Effect.succeed(result)),
          (error: unknown) => resume(Effect.fail(error)),
        );
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            pendingNext = undefined;
          }),
        ),
      );
      const pump = Effect.gen(function* () {
        while (true) {
          // If the CLI aborts for a steer but drops its continuation, don't keep the
          // logical turn open forever. A running continuation's tools have their own watchdog.
          const next = yield* continuingSteer
            ? nextMessage.pipe(
                Effect.timeoutOrElse({
                  duration: Math.max(
                    0,
                    (continuationDeadline ?? 0) - (yield* Clock.currentTimeMillis),
                  ),
                  orElse: () => Effect.succeed(undefined),
                }),
              )
            : nextMessage;
          if (next === undefined) {
            continuingSteer = false;
            continuationDeadline = undefined;
            steers = 0;
            resetUsage();
            mapper.continued();
            emit({ type: "turnEnd", reason: "interrupted" });
            yield* Effect.logWarning("Claude steering continuation did not arrive").pipe(
              Effect.annotateLogs({ threadId: o.threadId }),
            );
            continue;
          }
          if (next.done === true) return;
          if (next.value.type === "result") {
            yield* (
              next.value.terminal_reason === "aborted_tools" ||
                next.value.terminal_reason === "aborted_streaming"
                ? Effect.logInfo
                : Effect.logDebug
            )("Claude SDK result").pipe(
              Effect.annotateLogs({
                threadId: o.threadId,
                subtype: next.value.subtype,
                terminalReason: next.value.terminal_reason,
                steers,
              }),
            );
          }
          onMessage(next.value);
          if (continuingSteer) {
            continuationDeadline ??= (yield* Clock.currentTimeMillis) + 60_000;
          } else {
            continuationDeadline = undefined;
          }
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            endedReason ??= `error: ${describeError(error)}`;
          }),
        ),
        Effect.andThen(
          Effect.sync(() => {
            for (const event of mapper.flush()) emit(event);
            emit({ type: "ended", reason: endedReason ?? "exited" });
            Queue.endUnsafe(events);
          }),
        ),
      );
      yield* Effect.forkScoped(pump);

      // A running shell command's output, read back from the CLI while its Bash call waits (the
      // stream carries none until it exits) or while it runs in the background (its call already
      // has its result). A control request, not a tool call, so the model sees nothing of it. A task the CLI won't read for us (an older CLI, a diskless or
      // redacting lane) is left alone after its first refusal or a reply in another shape, or
      // after SHELL_OUTPUT_TIMEOUTS unanswered reads in a row. Shells are read side by side, so
      // one slow read holds up no other.
      const readTaskOutput = taskOutputReader(q);
      if (readTaskOutput !== undefined) {
        const unreadable = new Set<string>();
        const timeouts = new Map<string, number>();
        const readShell = (taskId: string) =>
          Effect.tryPromise(() => readTaskOutput(taskId)).pipe(
            Effect.map((value): ShellRead => ({ kind: "answer", value })),
            Effect.timeoutOrElse({
              duration: SHELL_OUTPUT_READ_TIMEOUT_MS,
              orElse: () => Effect.succeed<ShellRead>({ kind: "timeout" }),
            }),
            Effect.catch(() => Effect.succeed<ShellRead>({ kind: "refused" })),
            Effect.map((read) => {
              if (read.kind === "timeout") {
                const count = (timeouts.get(taskId) ?? 0) + 1;
                timeouts.set(taskId, count);
                if (count >= SHELL_OUTPUT_TIMEOUTS) unreadable.add(taskId);
                return;
              }
              timeouts.delete(taskId);
              if (read.kind === "refused" || !isTaskOutputRead(read.value)) {
                unreadable.add(taskId);
                return;
              }
              for (const event of mapper.shellOutput(taskId, read.value)) emit(event);
            }),
          );
        const readShells = Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(SHELL_OUTPUT_POLL_MS);
            const shells = mapper.runningShells().filter((s) => !unreadable.has(s.taskId));
            if (shells.length === 0) continue;
            yield* Effect.forEach(shells, (shell) => readShell(shell.taskId), {
              concurrency: "unbounded",
              discard: true,
            });
          }
        });
        yield* Effect.forkScoped(readShells);
      }

      const setMode = (mode: PermissionMode) =>
        Effect.tryPromise({
          try: () => q.setPermissionMode(mode),
          catch: (error) => new ModeRefused({ mode, message: describeError(error) }),
        });

      const session: AgentSession = {
        prepareForSwitch: Effect.gen(function* () {
          if (ownedChild === undefined || process.platform === "win32")
            return yield* new AgentUnavailable({
              agent: "claude",
              message:
                "The current Claude Code session cannot prove a graceful stop. No stop was requested.",
            });
          protectChildForSwitch(ownedChild);
        }),
        stopForSwitch: Effect.gen(function* () {
          if (ownedChild === undefined || process.platform === "win32")
            return yield* new AgentUnavailable({
              agent: "claude",
              message:
                "This Claude Code session cannot prove a graceful child exit. No replacement was started.",
            });
          const exited = yield* Effect.promise(() => stopChildForSwitch(ownedChild!));
          if (!exited)
            return yield* new AgentUnavailable({
              agent: "claude",
              message:
                "The previous Claude Code child did not exit after a graceful stop. No replacement was started.",
            });
        }),
        acceptSwitchStartup: (attemptId) =>
          Effect.suspend(() =>
            !closed &&
            attemptId === o.switchStartup &&
            ownedChild !== undefined &&
            acceptSwitchStartup !== undefined &&
            acceptChildSwitchStartup(ownedChild, acceptSwitchStartup)
              ? Effect.void
              : Effect.fail(
                  new AgentUnavailable({
                    agent: "claude",
                    message: "Stale or stopped orchestrator switch startup.",
                  }),
                ),
          ),
        // Single consumer: the thread runtime.
        events: Stream.fromQueue(events),
        processId: Effect.sync(() => processId),
        send: (message, sendOptions) => {
          const messageId = sendOptions?.messageId;
          if (messageId !== undefined && !isUuid(messageId)) {
            return Effect.die(new Error(`send: messageId must be a UUID, got "${messageId}"`));
          }
          return Effect.sync(() => {
            // The next reply answers this send, not a background subagent's report.
            mapper.sent();
            resetUsage();
            turnStarts();
            input.push(
              messageId === undefined
                ? userMessage(message)
                : userMessage(message, { uuid: messageId }),
            );
          });
        },
        steer: (message) =>
          Effect.sync(() => {
            steers++;
            turnStarts();
            input.push(userMessage(message, { priority: "now" }));
          }),
        // One `stopTask` each. A task that ended in the meantime rejects, which is the outcome
        // wanted; its `task_notification` takes it off the list either way.
        stopBackgroundTasks: Effect.suspend(() => {
          const ids = [...backgroundTasks];
          return Effect.forEach(
            ids,
            (id) => Effect.tryPromise(() => q.stopTask(id)).pipe(Effect.ignore),
            {
              concurrency: "unbounded",
              discard: true,
            },
          ).pipe(Effect.as(ids.length));
        }),
        // A task that ended in the meantime rejects: that is a `false`, as for one never running.
        stopTask: (taskId) =>
          backgroundTasks.has(taskId)
            ? Effect.tryPromise(() => q.stopTask(taskId)).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(false),
        ...(gated ? { closeToolGate: Effect.sync(() => void toolGate.close()) } : {}),
        interrupt: Effect.sync(() => {
          steers = 0;
          continuingSteer = false;
          continuationDeadline = undefined;
        }).pipe(
          Effect.andThen(Effect.tryPromise(() => q.interrupt())),
          Effect.ignore,
          Effect.timeoutOrElse({
            duration: interruptTimeoutMs,
            orElse: () => Effect.fail(new InterruptHung({ timeoutMs: interruptTimeoutMs })),
          }),
        ),
        respond: (requestId, answer) =>
          Effect.gen(function* () {
            const p = pending.get(requestId);
            if (p === undefined) return;
            const resolution = resolveRequest(p.request, p.input, answer, config.settingSources);
            const mode = resolution.setMode;
            // Switch before returning from `canUseTool`, so the next tool call sees the new mode.
            // A refused mode must not strand the answer: the request settles either way, and the
            // session stays in the mode it was in.
            if (mode !== undefined) {
              yield* setMode(mode).pipe(
                Effect.catch((refused) =>
                  Effect.sync(() =>
                    emit({
                      type: "notice",
                      level: "warning",
                      message: `Claude Code didn't switch to ${mode} mode: ${refused.message}`,
                    }),
                  ),
                ),
              );
            }
            p.settle(resolution.result);
          }),
        setMode,
        // `gatewayModelEnv` routes subagents by the opening model's data zone, and the child's env
        // can't change, so a switch across the EU boundary reopens rather than leave an EU
        // thread's subagents on US routes (or a US thread's on EU ones). So does one between a
        // model with hosted web search and one without, which `disallowedTools` was set for.
        needsReopenFor: (model) =>
          gateway !== undefined &&
          (inEuZone(model) !== inEuZone(o.model?.model) ||
            withoutWebSearch(gateway.profile.models, model) !==
              withoutWebSearch(gateway.profile.models, o.model?.model)),
        setModel: (model) =>
          Effect.tryPromise(async () => {
            if (model.speed === "fast") {
              if (!supportsFastControl(runningCli))
                throw new Error(
                  "Claude Fast requires a known Claude Code version of 2.1.205 or later.",
                );
              const problem = fastSelectionProblem(
                model,
                (await q.supportedModels()).map(toAgentModel),
              );
              if (problem !== undefined) throw new Error(problem);
            }
            // Disable Fast before switching to a model that doesn't support it. Flag overlays
            // affect this session only; never write user/project settings or invoke /fast.
            if (model.speed === "standard" && model.speed !== speed) {
              await q.applyFlagSettings({ fastMode: false });
              speed = model.speed;
              emit({
                type: "speed",
                state: {
                  speed: "unknown",
                  detail: "Speed selection applies to the next request; awaiting the CLI report.",
                },
              });
            }
            // Before the await, so the hook's resolved id lands after what was merely asked for.
            mapper.setSessionModel(model.model);
            await q.setModel(model.model);
            advertise(model.model);
            if (model.speed === "fast" && model.speed !== speed) {
              await q.applyFlagSettings({ fastMode: true });
              speed = model.speed;
              emit({
                type: "speed",
                state: {
                  speed: "unknown",
                  detail: "Speed selection applies to the next request; awaiting the CLI report.",
                },
              });
            }
            const next = effortOf(model);
            if (next === effort) return;
            // `null` resets to the model's default effort.
            await q.applyFlagSettings({ effortLevel: next ?? null });
            effort = next;
          }).pipe(Effect.orDie),
        connectors: {
          ...makeConnectors(q, lists, {
            gateway: gateway !== undefined,
            noToolSearch,
            observe: (servers) => {
              observeConnectors(servers.map(seenServer));
              seen(
                true,
                servers.map((server) => toConnectorStatus(server)),
              );
            },
          }),
          // What the options above let in: none when confined, else the lists there are.
          ...(o.confineWrites === true ? { allowlist: [] } : reportedLists(lists)),
        },
        addDirectories: (paths) =>
          Effect.tryPromise(() =>
            q.applyFlagSettings({ permissions: { additionalDirectories: [...paths] } }),
          ).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
      };
      return session;
    });
    const open: AgentHost["open"] = (o) =>
      Effect.suspend(() => {
        if (o.switchStartup === undefined) return openSession(o);
        const id = o.switchStartup;
        if (switchAttempts.has(id))
          return Effect.fail(
            new AgentUnavailable({
              agent: "claude",
              message: "This switch startup attempt was already used.",
            }),
          );
        const attempt = { allowSpawn: true, spawned: false, notStarted: false };
        switchAttempts.set(id, attempt);
        const close = Effect.sync(() => {
          attempt.allowSpawn = false;
          if (!attempt.spawned) attempt.notStarted = true;
        });
        return Effect.addFinalizer(() => close).pipe(
          Effect.andThen(
            openSession(o).pipe(
              Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)),
            ),
          ),
        );
      });

    let models: { readonly list: ReadonlyArray<AgentModel>; readonly at: number } | undefined;
    // Bumped by each reset, so a listing that began before one can't store what it got after.
    let modelsGeneration = 0;
    const modelsLock = yield* Semaphore.make(1);
    const fetchModels = Effect.gen(function* () {
      const generation = modelsGeneration;
      const prepared = yield* environment.prepare;
      yield* environment.checkAuth(prepared);
      const infos = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          sdk.query({
            prompt: silentPrompt,
            options: {
              ...(prepared.sdkExecutable === undefined
                ? {}
                : { pathToClaudeCodeExecutable: prepared.sdkExecutable }),
              // The listing needs no MCP server, and Claude Code connects every one it has as it
              // starts, only to drop them at `close` a moment later: a remote server is connected
              // and a stdio server is started and killed for nothing.
              strictMcpConfig: CONFINED_MCP.strictMcpConfig,
              env: { ...prepared.env, ...CONFINED_MCP.env },
              cwd: homedir(),
              ...(config.settingSources === undefined
                ? {}
                : { settingSources: [...config.settingSources] }),
            },
          }),
        ),
        (q) => Effect.tryPromise(() => q.supportedModels()),
        (q) => Effect.sync(() => q.close()),
      ).pipe(
        Effect.timeoutOrElse({
          duration: startupTimeoutMs,
          orElse: () => Effect.fail(new Error(`no response within ${startupTimeoutMs} ms`)),
        }),
        Effect.mapError(
          (error) =>
            new AgentUnavailable({
              agent: "claude",
              reason: "startup-failed",
              message: `Couldn't list Claude models: ${describeError(error)}`,
            }),
        ),
      );
      const fastControl = supportsFastControl(
        prepared.sdkExecutable === undefined
          ? expectedCliVersion(sdk.version)
          : prepared.cliVersion,
      );
      const list = infos.map((info) =>
        toAgentModel(
          fastControl || info.supportsFastMode !== true
            ? info
            : { ...info, supportsFastMode: false },
        ),
      );
      if (generation === modelsGeneration) models = { list, at: yield* Clock.currentTimeMillis };
      return list;
    });
    // What the account offers changes under a running server (a model granted, or withdrawn), so a
    // listing is only trusted for `MODELS_TTL_MS`. A transient failure keeps the last list, but
    // an authentication failure must withdraw it instead of presenting stale account access.
    const listModels = modelsLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (models !== undefined && now - models.at < MODELS_TTL_MS) return models.list;
        const last = models;
        return yield* last === undefined
          ? fetchModels
          : fetchModels.pipe(
              Effect.catch((error) =>
                error.reason === "not-logged-in" ||
                error.reason === "api-key-auth" ||
                error.reason === "third-party-provider"
                  ? Effect.fail(error)
                  : Effect.succeed(last.list),
              ),
            );
      }),
    );

    const forgetModels = Effect.sync(() => {
      models = undefined;
      modelsGeneration += 1;
    });

    const sdkListSessions = sdk.listSessions;
    const sdkDeleteSession = sdk.deleteSession;
    const sdkSessionMessages = sdk.getSessionMessages;

    return {
      kind: "claude",
      supportsWorkspaceSwitch: process.platform !== "win32",
      checkWorkspaceSwitch: environment.prepare.pipe(Effect.flatMap(environment.checkAuth)),
      switchAttemptReceipt: (id) =>
        Effect.sync(() =>
          releasedSwitches.has(id)
            ? "exited"
            : switchAttempts.get(id)?.notStarted
              ? "notStarted"
              : undefined,
        ),
      switchAttemptReleased: (id) =>
        Effect.sync(() => releasedSwitches.has(id) || switchAttempts.get(id)?.notStarted === true),
      capabilities: CLAUDE_CAPABILITIES,
      open,
      // Each session runs its own process, so only sessions opened from now on start the new one.
      // A new CLI, or settings re-read, may offer other models, so the next listing asks afresh.
      invalidateRuntime: environment.invalidate.pipe(Effect.andThen(forgetModels)),
      // The new process reads settings, MCP config, claude.ai connectors and CLAUDE.md itself; only
      // the executable and the login shell's environment are kept, and re-read here.
      reloadConfig: () => environment.invalidate.pipe(Effect.andThen(forgetModels)),
      listModels: () => listModels,
      readSubscriptionLimits: Effect.gen(function* () {
        const prepared = yield* environment.prepare;
        yield* environment.checkAuth(prepared);
        return yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            sdk.query({
              prompt: silentPrompt,
              options: {
                ...(prepared.sdkExecutable === undefined
                  ? {}
                  : { pathToClaudeCodeExecutable: prepared.sdkExecutable }),
                cwd: homedir(),
                env: { ...prepared.env, ...CONFINED_MCP.env },
                strictMcpConfig: true,
                settingSources: [],
                tools: [],
                persistSession: false,
                extraArgs: { "safe-mode": null },
                stderr: () => {},
              },
            }),
          ),
          (q) =>
            Effect.tryPromise(() =>
              q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
            ),
          (q) => Effect.sync(() => q.close()),
        ).pipe(
          Effect.map(claudeSubscriptionLimits),
          Effect.timeoutOrElse({
            duration: startupTimeoutMs,
            orElse: () => Effect.fail(new Error("Usage query timed out")),
          }),
          Effect.mapError(
            () =>
              new AgentUnavailable({
                agent: "claude",
                reason: "startup-failed",
                message: "Claude Code could not read subscription limits.",
              }),
          ),
        );
      }),
      ...(sdkListSessions === undefined
        ? {}
        : {
            listSessions: ({ cwd, limit }) =>
              Effect.tryPromise({
                try: () =>
                  sdkListSessions(limit === undefined ? { dir: cwd } : { dir: cwd, limit }),
                catch: (error) =>
                  new AgentUnavailable({
                    agent: "claude",
                    reason: "startup-failed",
                    message: `Couldn't list Claude sessions: ${describeError(error)}`,
                  }),
              }).pipe(Effect.map((infos) => infos.map(toSessionSummary))),
          }),
      ...(sdkListSessions === undefined || sdkDeleteSession === undefined
        ? {}
        : {
            deleteSession: ({ cwd, agentSessionId }) =>
              Effect.tryPromise({
                try: async () => {
                  // Only a session this folder's listing shows, never another project's transcript.
                  const listed = await sdkListSessions({ dir: cwd });
                  if (!listed.some((info) => info.sessionId === agentSessionId)) return false;
                  await sdkDeleteSession(agentSessionId, { dir: cwd });
                  return true;
                },
                catch: (error) =>
                  new AgentUnavailable({
                    agent: "claude",
                    message: `Couldn't delete the Claude session: ${describeError(error)}`,
                  }),
              }).pipe(
                Effect.flatMap((deleted) =>
                  deleted
                    ? Effect.void
                    : Effect.fail(
                        new NotFound({
                          entity: "session",
                          id: agentSessionId,
                          message: `No Claude session ${agentSessionId} in ${cwd}.`,
                        }),
                      ),
                ),
              ),
          }),
      ...(sdkSessionMessages === undefined
        ? {}
        : {
            // Scoped to the folder's project: another project's transcript reads as empty.
            previewSession: ({ cwd, agentSessionId }) =>
              Effect.tryPromise({
                try: () => sdkSessionMessages(agentSessionId, { dir: cwd }),
                catch: (error) =>
                  new AgentUnavailable({
                    agent: "claude",
                    message: `Couldn't read the Claude session: ${describeError(error)}`,
                  }),
              }).pipe(Effect.map(toSessionPreview)),
            readSession: ({ cwd, agentSessionId, limit }) =>
              Effect.tryPromise({
                try: () =>
                  sdkSessionMessages(agentSessionId, {
                    dir: cwd,
                    includeSystemMessages: true,
                    ...(limit === undefined ? {} : { limit }),
                  }),
                catch: (error) =>
                  new AgentUnavailable({
                    agent: "claude",
                    message: `Couldn't read the Claude session: ${describeError(error)}`,
                  }),
              }).pipe(
                Effect.flatMap((messages) =>
                  // The SDK answers an id this folder doesn't have with no messages, not an error.
                  messages.length === 0
                    ? Effect.fail(
                        new NotFound({
                          entity: "session",
                          id: agentSessionId,
                          message: `No Claude session ${agentSessionId} in ${cwd}.`,
                        }),
                      )
                    : Effect.succeed({
                        agentSessionId,
                        cwd,
                        messages: toSessionTranscript(messages),
                      }),
                ),
              ),
          }),
    } satisfies AgentHost;
  });

export const ClaudeHostLayer = (
  config: ClaudeHostConfig = {},
): Layer.Layer<ClaudeHost, never, ClaudeSdk | ClaudeEnvironment> =>
  Layer.effect(ClaudeHost)(makeClaudeHost(config));

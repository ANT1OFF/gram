import { codexSubscriptionLimits } from "./limits.ts";
import {
  AgentUnavailable,
  InterruptHung,
  MessageId,
  NotFound,
  ReasoningVariant,
  gatewayAgentModels,
  fastSelectionProblem,
  type AgentCapabilities,
  type AgentEvent,
  type AgentModel,
  type AgentSessionSummary,
  type CodexHome,
  type ConfiguredServer,
  type PermissionMode,
  type ProfileId,
  type RequestId,
  type SlashCommand,
  type UserInput,
} from "@gram/contracts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { dreamSupportFor } from "../dream-support.ts";
import { APP_TOOLS_SERVER_NAME } from "../app-tools.ts";
import { promptText } from "../claude/session.ts";
import { GatewayKeyProvider } from "../gateway.ts";
import {
  BUILT_IN_TOGGLE_REASON,
  type AgentHost,
  type AgentSession,
  type ConnectorStatus,
  type ListModelsOptions,
  type OpenSessionOptions,
  type OutwardGate,
} from "../host.ts";
import { codexServerEntry, describeCodexEntry } from "../mcp-native.ts";
import { listsLeaveOut, narrowsMcp, reportedLists, type McpLists } from "../mcp-lists.ts";
import { gateLevel } from "../outward.ts";
import { acquireHeld } from "../servers-hold.ts";
import { startupDiagnostic } from "./startup-diagnostic.ts";
import { makeCodexMapper } from "./mapper.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { ApprovalsReviewer } from "./protocol/v2/ApprovalsReviewer.ts";
import type { AskForApproval } from "./protocol/v2/AskForApproval.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { McpAuthStatus } from "./protocol/v2/McpAuthStatus.ts";
import type { McpServerConnectionStatus } from "./protocol/v2/McpServerConnectionStatus.ts";
import type { McpServerOauthLoginCompletedNotification } from "./protocol/v2/McpServerOauthLoginCompletedNotification.ts";
import type { McpServerStatus } from "./protocol/v2/McpServerStatus.ts";
import type { Model } from "./protocol/v2/Model.ts";
import type { SandboxMode } from "./protocol/v2/SandboxMode.ts";
import type { SandboxPolicy } from "./protocol/v2/SandboxPolicy.ts";
import type { Thread } from "./protocol/v2/Thread.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { Turn } from "./protocol/v2/Turn.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import { GATE_ACCEPT, gateVerdict, responseFor, toPendingRequest } from "./requests.ts";
import { isServerRequest, type CodexRpc, type CodexRpcError } from "./rpc.ts";
import { makeCodexHelper } from "./helper.ts";
import { CodexServers, SERVER_WIDE, type CodexServer, type CodexServersConfig } from "./servers.ts";
import { toCodexTranscript } from "./transcript.ts";

/**
 * What a Codex thread supports.
 * - `rewind: "history"`: `thread/revert` drops later turns from the history only; files stay as
 *   they are (Codex has no file snapshots).
 * - `steer`: `turn/steer` adds input to the running turn, answered at the next model call.
 * - `planMode`: Codex's plan collaboration mode, where it can also ask questions.
 * - `approvalScopes`: accept once, for the session, or always (an exec policy amendment for
 *   commands).
 * - `costReporting: false`: Codex reports tokens but no cost.
 * - `subagentStreams: false`: Codex's sub-agents run as separate threads the adapter doesn't follow.
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  fork: true,
  rewind: "history",
  steer: true,
  planMode: true,
  approvalScopes: ["once", "session", "always"],
  userQuestions: true,
  costReporting: false,
  perTurnModel: true,
  reasoningEffort: true,
  listSessions: true,
  subagentStreams: false,
  stopTasks: false,
};

export class CodexHost extends Context.Service<CodexHost, AgentHost>()("@gram/agents/CodexHost") {}

export interface CodexHostConfig {
  /** Runtime configuration for fresh subscription helper layers, independent of visible sessions. */
  readonly helperServers?: CodexServersConfig;
  /** Watchdog for `interrupt()`; the runtime closes and resumes on `InterruptHung`. */
  readonly interruptTimeoutMs?: number;
  readonly newId?: () => string;
}

const unavailable = (what: string) => (error: CodexRpcError) =>
  new AgentUnavailable({
    agent: "codex",
    reason: "startup-failed",
    message: `${what}: ${error.message}`,
  });

/**
 * `unavailable(what)`, naming which of `paths` don't exist when Codex failed on a missing file, as
 * its own error ("No such file or directory (os error 2)") names none.
 */
const unavailableNaming =
  (what: string, paths: ReadonlyArray<string>) =>
  (error: CodexRpcError): AgentUnavailable => {
    const failed = unavailable(what)(error);
    if (!error.message.includes("No such file or directory")) return failed;
    const missing = paths.filter((path) => !existsSync(path));
    return missing.length === 0
      ? failed
      : new AgentUnavailable({
          ...failed,
          message: `${failed.message}; missing ${missing.join(", ")}`,
        });
  };

const VARIANTS: ReadonlySet<string> = new Set(ReasoningVariant.literals);

const efforts = (variants: Iterable<string>): Array<ReasoningVariant> =>
  [...variants].filter((v): v is ReasoningVariant => VARIANTS.has(v));

const catalogModel = (model: Model): AgentModel => {
  const choices = efforts(model.supportedReasoningEfforts.map((option) => option.reasoningEffort));
  return {
    id: model.id,
    displayName: model.displayName,
    ...(model.description === "" ? {} : { description: model.description }),
    supportsEffort: choices.length > 0,
    ...(model.inputModalities === undefined
      ? {}
      : {
          inputModalities: model.inputModalities.filter(
            (modality) => modality === "text" || modality === "image",
          ),
        }),
    // New catalogs declare serviceTiers; older ones may only advertise additionalSpeedTiers.
    ...(model.serviceTiers !== undefined || model.additionalSpeedTiers !== undefined
      ? {
          speeds: [
            "standard" as const,
            ...((
              model.serviceTiers !== undefined
                ? model.serviceTiers.some((tier) => tier.id === "priority" || tier.id === "fast")
                : model.additionalSpeedTiers?.some((tier) => tier === "fast" || tier === "priority")
            )
              ? ["fast" as const]
              : []),
          ],
        }
      : {}),
    ...(choices.length > 0 ? { efforts: choices } : {}),
    ...(model.isDefault ? { isDefault: true } : {}),
  };
};

/**
 * Codex's approval policy and sandbox for a permission mode, and what changes when the session is
 * under the outward gate (`OpenSessionOptions.outwardGate`). Measured on codex 0.154.0:
 *
 * | Mode                                     | Ungated                          | Gated                              |
 * | ---------------------------------------- | -------------------------------- | ---------------------------------- |
 * | `bypassPermissions`                      | `never` + `danger-full-access`   | `untrusted` + `danger-full-access` |
 * | `default`, `acceptEdits`, `auto`, `plan` | `on-request` + `workspace-write` | the same                           |
 * | `dontAsk`                                | `never` + `workspace-write`      | the same                           |
 *
 * - Bypass: `never` with full access runs `git push` with no request, so a gated session never sends
 *   it. Under `untrusted` Codex asks about every command and every patch with the whole command line
 *   in the request; the adapter accepts all but the outward commands unseen (`gateVerdict`), and
 *   those become a once-only card.
 * - The sandboxed modes: the sandbox has no network, so a plain push fails, and an escalated one is
 *   a request whose card shows the command, once-only. Nothing is accepted unseen here: in a sandbox
 *   an escalation request differs from a plain one by nothing but a `reason` the model writes, so
 *   accepting on the command alone would grant every escalation.
 * - `dontAsk`: nothing can ask. The sandbox still blocks the network, but the gate doesn't hold
 *   (`gateHoldsInMode`).
 *
 * The gate's level (`OutwardGate`) changes none of this, only which commands count: at
 * `irreversible` a push and a new PR are accepted unseen in bypass like any other command, and in a
 * sandboxed mode their escalation is an ordinary card (without "always", see `toPendingRequest`).
 */
export const policyFor = (
  mode: PermissionMode,
  outwardGate: boolean | OutwardGate = false,
): { readonly approvalPolicy: AskForApproval; readonly sandbox: SandboxMode } => {
  switch (mode) {
    case "bypassPermissions":
      return {
        approvalPolicy: gateLevel(outwardGate) === undefined ? "never" : "untrusted",
        sandbox: "danger-full-access",
      };
    case "dontAsk":
      return { approvalPolicy: "never", sandbox: "workspace-write" };
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
};

/**
 * Whether the outward gate can hold in `mode`: every mode but `dontAsk`, whose `never` policy leaves
 * Codex nothing to ask with. For the server to decide which modes a gated thread may be put in.
 */
export const gateHoldsInMode = (mode: PermissionMode): boolean => mode !== "dontAsk";

/** The one mode where a gated session answers Codex's requests itself; see `policyFor`. */
const gateAnswersInMode = (mode: PermissionMode): boolean => mode === "bypassPermissions";

/**
 * Whether a gated session may run on `home`. Only Gram's own `CODEX_HOME` will do, and only
 * when the servers can put the gate's prompt rules in it (`CodexServers.gateReady`). An allow rule,
 * which is what "always allow" writes (`prefix_rule(["git", "push", …], decision="allow")` in
 * `$CODEX_HOME/rules`, or the repo's `.codex/rules`), runs a push with no request in every approval
 * policy, so the adapter never sees it; a `prompt` rule beside it outranks it. The user's `~/.codex`
 * is theirs: nothing is written there, so nothing gated runs there.
 */
export const gatedHomeIsOwned = (home: CodexHome, gateReady: boolean): boolean =>
  (home === "gateway" || home === "owned") && gateReady;

const sandboxPolicy = (sandbox: SandboxMode, roots: ReadonlyArray<string>): SandboxPolicy =>
  sandbox === "danger-full-access"
    ? { type: "dangerFullAccess" }
    : sandbox === "read-only"
      ? { type: "readOnly", networkAccess: false }
      : {
          type: "workspaceWrite",
          writableRoots: [...roots],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        };

/** The name of the thread's own app-tools MCP server. */
const APP_TOOLS_NAME = APP_TOOLS_SERVER_NAME;

const CODEX_RECONNECT_REASON = "Codex reconnects its MCP servers when the thread restarts.";

const CONNECTION_STATE: Record<McpServerConnectionStatus, ConnectorStatus["status"]> = {
  notStarted: "pending",
  starting: "pending",
  connected: "connected",
  authenticationRequired: "needs-auth",
  failed: "failed",
  cancelled: "failed",
  disabled: "disabled",
};

/**
 * A Codex MCP server's thread status as a connector; `builtIn` for the thread's app tools. A server
 * no plugin brought comes from `config.toml`, Codex's one scope, which is what makes it removable.
 */
const toConnectorStatus = (status: McpServerStatus, builtIn: boolean): ConnectorStatus => ({
  name: status.name,
  status: status.runtimeStatus === null ? "pending" : CONNECTION_STATE[status.runtimeStatus],
  ...(status.toolsError === null ? {} : { error: status.toolsError }),
  ...(builtIn || status.pluginId !== null ? {} : { scope: "user" }),
  reconnectUnavailable: CODEX_RECONNECT_REASON,
  ...(builtIn ? { builtIn: true, toggleUnavailable: BUILT_IN_TOGGLE_REASON } : {}),
});

/** `config/batchWrite`'s edit for one server's table; `undefined` removes it. */
const serverEdit = (name: string, entry: Record<string, unknown> | undefined) => ({
  edits: [
    {
      keyPath: `mcp_servers.${name}`,
      value: (entry ?? null) as JsonValue,
      mergeStrategy: "replace" as const,
    },
  ],
  // Loaded threads share a child: a write must not live-refresh their MCP managers.
  reloadUserConfig: false,
});

const asUnavailable = (error: AgentUnavailable | { readonly message: string }) =>
  error instanceof AgentUnavailable
    ? error
    : new AgentUnavailable({ agent: "codex", message: error.message });

/** How long a sign-in started from Settings is listened for; the user may never finish it. */
const SIGN_IN_WAIT = Duration.minutes(15);

/**
 * A sign-in to `name` started with no thread, on a user-home app-server held for its whole length
 * like a session's (`acquireHeld`), so a config change retiring the server can't stop it while the
 * user is in the browser. `started` gets the page to open, or why there is none; the result is
 * whether it succeeded, `false` too when the app-server went or `SIGN_IN_WAIT` passed.
 */
const threadlessSignIn = (
  servers: CodexServers["Service"],
  name: string,
  started: Deferred.Deferred<{ readonly authorizationUrl: string }, AgentUnavailable>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* acquireHeld(servers.acquire(undefined, "user"));
      const done = yield* Deferred.make<boolean>();
      // Listening before the request, so a completion can't come before anyone hears it.
      yield* server.subscribe(SERVER_WIDE, {
        message: (message) => {
          if (
            message.method === "mcpServer/oauthLogin/completed" &&
            message.params.name === name &&
            message.params.threadId === null
          ) {
            Deferred.doneUnsafe(done, Effect.succeed(message.params.success));
          }
        },
        exit: () => Deferred.doneUnsafe(done, Effect.succeed(false)),
      });
      const { authorizationUrl } = yield* server.rpc.request("mcpServer/oauth/login", { name });
      yield* Deferred.succeed(started, { authorizationUrl });
      return yield* Deferred.await(done).pipe(
        Effect.timeoutOption(SIGN_IN_WAIT),
        Effect.map((succeeded) => Option.getOrElse(succeeded, () => false)),
      );
    }),
  ).pipe(
    Effect.tapError((error) => Deferred.fail(started, asUnavailable(error))),
    Effect.orElseSucceed(() => false),
    // The host closing first still answers the caller; a no-op once `started` has its answer.
    Effect.ensuring(
      Deferred.fail(
        started,
        new AgentUnavailable({ agent: "codex", message: "Codex stopped before signing in" }),
      ),
    ),
  );

/** Whether Codex holds a sign-in for each server; absent for one with nothing to sign in to. */
const SIGNED_IN: Readonly<Partial<Record<McpAuthStatus, boolean>>> = {
  notLoggedIn: false,
  oAuth: true,
};

/**
 * `config/read`'s `mcp_servers` for showing. The response carries every header and env value, and
 * `describeCodexEntry` drops them. A server's scope is the config layer its address came from:
 * `user` for `config.toml`, the one layer Gram writes.
 */
const configuredServers = (
  read: ConfigReadResponse,
  auth: ReadonlyMap<string, McpAuthStatus> | undefined,
): ReadonlyArray<ConfiguredServer> => {
  const tables = read.config["mcp_servers"];
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) return [];
  return Object.entries(tables).flatMap(([name, entry]) => {
    const description = describeCodexEntry(entry);
    if (description === undefined) return [];
    const origin =
      read.origins[`mcp_servers.${name}.url`] ?? read.origins[`mcp_servers.${name}.command`];
    const signedIn = SIGNED_IN[auth?.get(name) ?? "unknown"];
    return [
      {
        name,
        scope: origin?.name.type ?? "user",
        ...description,
        ...(signedIn === undefined ? {} : { signedIn }),
      },
    ];
  });
};

const switchedOff = (keys: ReadonlyArray<string>) =>
  Object.fromEntries(keys.map((name) => [name, { enabled: false }]));

/**
 * The thread config that switches off every MCP server and ChatGPT app `config/read` names for
 * `cwd`, project layers included, except `own`: Gram's app tools, which the session states
 * itself. Codex starts them itself, outside the sandbox, so a confined
 * session can't keep them. Each goes by name: a `mcp_servers` table in the thread config merges
 * into the user's rather than replacing it (measured on codex 0.158.0). Plugin servers are loaded
 * separately and aren't all named by `config/read`; confined threads disable plugin loading too.
 * ChatGPT's built-in apps server is feature-owned, so app policy alone doesn't stop it starting.
 */
export const confinedConfig = (read: ConfigReadResponse, own: string | undefined) => {
  const names = (key: string) => {
    const table = read.config[key];
    return typeof table === "object" && table !== null && !Array.isArray(table)
      ? Object.keys(table)
      : [];
  };
  return {
    mcp_servers: switchedOff(names("mcp_servers").filter((name) => name !== own)),
    features: { plugins: false, apps: false },
    apps: {
      ...switchedOff(names("apps").filter((name) => name !== "_default")),
      _default: { enabled: false },
    },
  };
};

/**
 * The thread config that switches off each MCP server `config/read` names for `cwd` that the
 * session's lists leave out (`listsLeaveOut`), matched by its name and the `url` its table gives;
 * `own` is Gram's, which stays. ChatGPT apps aren't MCP servers here, and keep to the user's
 * config.
 */
export const leftOutConfig = (
  read: ConfigReadResponse,
  lists: McpLists,
  own: string | undefined,
): Record<string, { enabled: boolean }> => {
  const tables = read.config["mcp_servers"];
  if (typeof tables !== "object" || tables === null || Array.isArray(tables)) return {};
  return switchedOff(
    Object.entries(tables)
      .filter(([name]) => name !== own)
      .filter(([name, table]) => {
        const url =
          typeof table === "object" && table !== null && "url" in table ? table.url : undefined;
        return listsLeaveOut(lists, { name, url: typeof url === "string" ? url : undefined });
      })
      .map(([name]) => name),
  );
};

/**
 * The servers a confined thread still has running that aren't Gram's own, by name: a
 * plugin's, or anything else `confinedConfig` couldn't name beforehand.
 */
export const unconfinedServers = (
  statuses: ReadonlyArray<McpServerStatus>,
  ownServer: boolean,
): ReadonlyArray<string> =>
  statuses
    .filter((status) => !(ownServer && status.name === APP_TOOLS_NAME))
    .filter((status) => status.runtimeStatus !== "disabled")
    .map((status) => status.name);

/**
 * Every page of a thread's MCP server statuses. With no thread Codex starts and connects every
 * configured server to answer, so that is only for a user who asked.
 */
const listServerStatus = (rpc: CodexRpc, threadId?: string) =>
  Effect.gen(function* () {
    const all: Array<McpServerStatus> = [];
    let cursor: string | null = null;
    do {
      const page: ListMcpServerStatusResponse = yield* rpc.request("mcpServerStatus/list", {
        ...(threadId === undefined ? {} : { threadId }),
        detail: "toolsAndAuthOnly",
        ...(cursor === null ? {} : { cursor }),
      });
      all.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return all;
  });

/** Codex compacts on `thread/compact/start`, which only its TUI's `/compact` sends. */
const COMPACT: SlashCommand = {
  name: "compact",
  description: "Summarize the conversation to free up context",
};

/** A prompt as Codex input; attachments become `@` mentions in the text. */
const toInput = (input: UserInput): TurnStartParams["input"] => [
  { type: "text", text: promptText(input), text_elements: [] },
];

/** A comparable path: trailing separators dropped, and case and separators folded on Windows. */
const pathKey = (path: string): string => {
  const trimmed = path.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.replaceAll("\\", "/").toLowerCase() : trimmed;
};

const toSessionSummary = (thread: Thread): AgentSessionSummary => ({
  agentSessionId: thread.id,
  title: thread.name?.trim() || thread.preview.trim() || thread.id,
  ...(thread.preview.trim() === "" ? {} : { firstPrompt: thread.preview }),
  updatedAt: thread.updatedAt * 1000,
  ...(thread.gitInfo?.branch ? { gitBranch: thread.gitInfo.branch } : {}),
  cwd: thread.cwd,
});

/** How many `thread/list` pages a folder's listing follows before it settles for what it has. */
const LIST_MAX_PAGES = 20;

/**
 * The root threads of `cwd`, newest first. `thread/list` answers for the whole home, newest first,
 * so the folder's threads are picked out page by page until there are enough of them: one page
 * alone would miss a folder's sessions behind fifty newer ones from everywhere else. Its own `cwd`
 * filter isn't used, since it matches a path exactly, and these are compared through `pathKey`.
 */
const listThreads = (rpc: CodexRpc, cwd: string, limit: number | undefined) =>
  Effect.gen(function* () {
    const wanted = limit ?? 50;
    const found: Array<Thread> = [];
    let cursor: string | null = null;
    for (let page = 0; page < LIST_MAX_PAGES && found.length < wanted; page++) {
      const listed: ThreadListResponse = yield* rpc.request("thread/list", {
        ...(cursor === null ? {} : { cursor }),
        limit: Math.max(wanted, 50),
        sortKey: "updated_at",
        // Left out, this is the server's default provider alone, and a listing server has none of
        // a gateway profile's: every thread of the gateway home, recorded under the profile's
        // provider, went unlisted (measured on codex 0.154.0). Empty is every provider.
        modelProviders: [],
      });
      found.push(
        ...listed.data.filter(
          (t) => t.parentThreadId === null && !t.ephemeral && pathKey(t.cwd) === pathKey(cwd),
        ),
      );
      cursor = listed.nextCursor;
      if (cursor === null) break;
    }
    return found.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, wanted);
  });

/** How many turns one `thread/turns/list` page asks for, and how many pages a read follows. */
const HISTORY_PAGE_TURNS = 100;
const HISTORY_MAX_PAGES = 50;

/**
 * A thread's turns with their items, oldest first, until there are none left or the transcript they
 * make has `limit` messages. Paged, because `thread/read` with `includeTurns` is deprecated for the
 * paginated history new threads are written with.
 */
const readTurns = (rpc: CodexRpc, threadId: string, limit: number | undefined) =>
  Effect.gen(function* () {
    const turns: Array<Turn> = [];
    let cursor: string | null = null;
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const listed: ThreadTurnsListResponse = yield* rpc.request("thread/turns/list", {
        threadId,
        cursor,
        limit: HISTORY_PAGE_TURNS,
        sortDirection: "asc",
        itemsView: "full",
      });
      turns.push(...listed.data);
      cursor = listed.nextCursor;
      if (cursor === null) break;
      if (limit !== undefined && toCodexTranscript(turns).length >= limit) break;
    }
    return turns;
  });

/**
 * The `CODEX_HOME` a session lives in: the one recorded when it was first opened; `user` for a
 * session resumed without one; for a new session, `gateway` on a gateway profile,
 * `owned` for a native gated session, and `user` otherwise.
 */
const codexHomeFor = (
  o: Pick<OpenSessionOptions, "codexHome" | "resumeId" | "model" | "outwardGate">,
): CodexHome =>
  o.codexHome ??
  (o.resumeId !== undefined
    ? "user"
    : o.model?.profileId !== undefined
      ? "gateway"
      : gateLevel(o.outwardGate) !== undefined
        ? "owned"
        : "user");

/** The session to run: new, resumed, forked, or reverted to just after the turn `resumeAt`. */
const resolveThread = (server: CodexServer, o: OpenSessionOptions, settings: ThreadSettings) =>
  Effect.gen(function* () {
    const { rpc } = server;
    if (o.resumeId === undefined)
      return yield* server.openThread(undefined, rpc.request("thread/start", settings));
    if (o.fork === true) {
      return yield* server.openThread(
        undefined,
        rpc.request("thread/fork", {
          ...settings,
          threadId: o.resumeId,
          ...(o.resumeAt === undefined ? {} : { lastTurnId: o.resumeAt }),
          excludeTurns: true,
        }),
      );
    }
    const resumed = yield* server.openThread(
      o.resumeId,
      rpc.request("thread/resume", {
        ...settings,
        threadId: o.resumeId,
        excludeTurns: true,
      }),
    );
    if (o.resumeAt === undefined) return resumed;
    const turns = yield* rpc.request("thread/turns/list", {
      threadId: o.resumeId,
      limit: 500,
      sortDirection: "asc",
    });
    const index = turns.data.findIndex((turn) => turn.id === o.resumeAt);
    if (index === -1) {
      return yield* Effect.fail(
        new AgentUnavailable({
          agent: "codex",
          message: `Turn ${o.resumeAt} isn't in thread ${o.resumeId}.`,
        }),
      );
    }
    const next = turns.data[index + 1];
    if (next !== undefined) {
      yield* rpc.request("thread/revert", { threadId: o.resumeId, beforeTurnId: next.id });
    }
    return resumed;
  });

/** What `thread/start`, `thread/resume` and `thread/fork` share. */
interface ThreadSettings {
  readonly cwd: string;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer?: ApprovalsReviewer;
  readonly sandbox: SandboxMode;
  readonly config?: NonNullable<ThreadStartParams["config"]>;
  /**
   * `OpenSessionOptions.instructions`. All three requests take it, so a resumed or forked thread
   * is told its role again, as a Claude session is at every open. A plan-mode turn's collaboration
   * mode brings its own developer instructions and outranks these for that turn.
   */
  readonly developerInstructions?: string;
}

export const makeCodexHost = (
  config: CodexHostConfig = {},
): Effect.Effect<AgentHost, never, CodexServers | GatewayKeyProvider | Scope.Scope> =>
  Effect.gen(function* () {
    const servers = yield* CodexServers;
    /** Outlives any session: a sign-in started from Settings has no thread to belong to. */
    const hostScope = yield* Effect.scope;
    const gateway = yield* GatewayKeyProvider;
    const newId = config.newId ?? randomUUID;
    const interruptTimeoutMs = config.interruptTimeoutMs ?? 5_000;
    /**
     * Per Gram thread: servers the user switched on or off. Codex can't toggle a server live,
     * so the choice applies when the session reopens, and survives that reopen here.
     */
    const serverOverrides = new Map<string, Map<string, boolean>>();
    /** The servers a sign-in from Settings finished signing in to, for `mcpConfig.signedIn`. */
    const signedInQueue = yield* Queue.unbounded<string>();

    const switchAttempts = new Map<string, { delegated: boolean; notStarted: boolean }>();
    const openSession = Effect.fnUntraced(function* (o: OpenSessionOptions) {
      if (o.dreamFilesOnly === true)
        return yield* new AgentUnavailable({
          agent: "codex",
          reason: "startup-failed",
          message:
            "Codex Dream is unavailable: this transport cannot disable every native tool while allowing only the bounded Dream file bridge. Choose Claude Code.",
        });
      if (o.audience === "dream" && (o.dreamGuided !== true || o.mcp === undefined))
        return yield* new AgentUnavailable({
          agent: "codex",
          reason: "startup-failed",
          message:
            "Guided Codex Dream requires its explicit mode and the bounded Dream file bridge.",
        });
      const home = codexHomeFor(o);
      // A server-owned thread's eviction must not strand its writer behind unrelated lifetimes.
      // This changes child acquisition only; the physical-home/thread ownership fence is global.
      const sessionPartitionId =
        o.audience === "orchestrator" || o.audience === "worker" ? o.threadId : undefined;
      const level = gateLevel(o.outwardGate);
      const gated = level !== undefined;
      if (
        gated &&
        !gatedHomeIsOwned(
          home,
          servers.gateReadyFor?.(home) ?? (home === "gateway" && servers.gateReady),
        )
      ) {
        return yield* new AgentUnavailable({
          agent: "codex",
          reason: "startup-failed",
          message:
            "This thread asks before a push. Codex needs Gram's prepared native or gateway home with prompt rules; the user's own Codex home cannot hold this gate.",
        });
      }
      // `o.confineWrites` leaves the sandbox alone: every sandboxed mode is `workspace-write` with the
      // network off (`policyFor`), so the OS already holds an `acceptEdits` session's writes to its
      // roots. What it does take is the MCP servers, which Codex runs outside the sandbox.
      if (o.switchStartup !== undefined) switchAttempts.get(o.switchStartup)!.delegated = true;
      if (o.waitForPreviousSession !== undefined && o.resumeId !== undefined && o.fork !== true) {
        const resolver = yield* servers.acquire(o.model?.profileId, home, sessionPartitionId);
        yield* resolver.waitForThreadExit(o.resumeId, o.waitForPreviousSession.onWait);
      }
      const server = yield* acquireHeld(
        servers.acquire(o.model?.profileId, home, sessionPartitionId, o.switchStartup),
      );
      if (home === "owned") {
        const account = yield* server.rpc
          .request("account/read", { refreshToken: false })
          .pipe(Effect.mapError(unavailable("Codex couldn't check its native login")));
        if (account.account?.type !== "chatgpt")
          return yield* new AgentUnavailable({
            agent: "codex",
            reason: "not-logged-in",
            message: "Gated native Codex requires your ChatGPT login. Run codex login, then retry.",
          });
      }
      const acceptSwitchStartup = o.switchStartup
        ? yield* (
            server.protectSwitchStartup?.(o.switchStartup) ??
              Effect.fail(
                new AgentUnavailable({
                  agent: "codex",
                  message: "This Codex host cannot safely start a switch target.",
                }),
              )
          )
        : undefined;
      let switchSessionLive = true;
      if (o.switchStartup !== undefined)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            switchSessionLive = false;
          }),
        );
      if (o.dreamGuided === true) {
        const support = dreamSupportFor("codex", {
          kind: "installed",
          cliVersion: server.cliVersion,
        });
        if (support.mode !== "guided")
          return yield* new AgentUnavailable({
            agent: "codex",
            reason: "startup-failed",
            message: support.reason,
          });
      }
      const needs = [o.cwd, ...server.generated];
      let mode: PermissionMode = o.permissionMode ?? "default";
      let model = o.model;
      if (model?.speed === "fast") {
        const problem = fastSelectionProblem(
          model,
          yield* listModels(model.profileId === undefined ? {} : { profileId: model.profileId }),
        );
        if (problem !== undefined)
          return yield* new AgentUnavailable({ agent: "codex", message: problem });
      }
      const roots = o.additionalDirectories ?? [];
      const confined =
        o.confineWrites === true
          ? confinedConfig(
              yield* server.rpc
                .request("config/read", { includeLayers: false, cwd: o.cwd })
                .pipe(
                  Effect.mapError(unavailableNaming("Codex couldn't read its MCP servers", needs)),
                ),
              o.mcp === undefined ? undefined : APP_TOOLS_NAME,
            )
          : undefined;
      // Confinement already switches every server off; otherwise the workspace's lists might.
      const narrowedRead =
        confined === undefined && narrowsMcp(o)
          ? yield* server.rpc
              .request("config/read", { includeLayers: false, cwd: o.cwd })
              .pipe(
                Effect.mapError(unavailableNaming("Codex couldn't read its MCP servers", needs)),
              )
          : undefined;
      const leftOut =
        narrowedRead === undefined
          ? {}
          : leftOutConfig(narrowedRead, o, o.mcp === undefined ? undefined : APP_TOOLS_NAME);
      const tables = narrowedRead?.config["mcp_servers"];
      /** The servers `config/read` names, which `leftOutConfig` has decided on already. */
      const configured = new Set(
        typeof tables === "object" && tables !== null ? Object.keys(tables) : [],
      );
      const overrides = serverOverrides.get(o.threadId) ?? new Map<string, boolean>();
      const mcpServers = {
        ...confined?.mcp_servers,
        ...leftOut,
        // A thread's own toggle turns a server off, never back on past confinement or the lists.
        ...Object.fromEntries(
          [...overrides]
            .filter(([name, enabled]) => !enabled || (confined === undefined && !(name in leftOut)))
            .map(([name, enabled]) => [name, { enabled }]),
        ),
        // App tools: one MCP server per thread, bound to it by the thread's bearer token. The
        // registry gates its own tools, so Codex doesn't ask again.
        ...(o.mcp === undefined
          ? {}
          : {
              [APP_TOOLS_NAME]: {
                // A same-named table in the user's or a project's config merges into this one, and
                // its `enabled = false` would otherwise take the thread's app tools away.
                enabled: true,
                url: o.mcp.url,
                http_headers: { ...o.mcp.headers },
                default_tools_approval_mode: "approve",
              },
            }),
      };
      const threadConfig: NonNullable<ThreadStartParams["config"]> = {
        ...(home === "owned"
          ? {
              model_provider: "openai",
              openai_base_url: "https://chatgpt.com/backend-api/codex",
              forced_login_method: "chatgpt",
              cli_auth_credentials_store: "file",
              features: {
                exec_policy: true,
                shell_snapshot: false,
                hooks: false,
                plugins: false,
                apps: false,
              },
            }
          : {}),
        ...(Object.keys(mcpServers).length === 0 ? {} : { mcp_servers: mcpServers }),
        ...(confined === undefined ? {} : { apps: confined.apps, features: confined.features }),
        ...(roots.length === 0 ? {} : { sandbox_workspace_write: { writable_roots: [...roots] } }),
      };
      // A reviewer other than the user (`auto_review`) would answer the outward request in the
      // user's place, so a gated session names the user whatever the home's config says.
      const reviewer = gated ? { approvalsReviewer: "user" as const } : {};
      const settings: ThreadSettings = {
        cwd: o.cwd,
        ...(home === "owned" ? { modelProvider: "openai", allowProviderModelFallback: false } : {}),
        ...(model === undefined || model.model === "default" ? {} : { model: model.model }),
        ...(model?.speed === undefined
          ? {}
          : { serviceTier: model.speed === "fast" ? "priority" : "default" }),
        ...policyFor(mode, gated),
        ...reviewer,
        ...(Object.keys(threadConfig).length === 0 ? {} : { config: threadConfig }),
        ...(o.instructions === undefined ? {} : { developerInstructions: o.instructions }),
      };
      const started = yield* servers
        .opening(
          home,
          level,
        )(resolveThread(server, o, settings))
        .pipe(
          Effect.catchDefect(() =>
            Effect.fail(
              new AgentUnavailable({
                agent: "codex",
                message:
                  "Gram could not refresh its Codex approval home. Check codex login and the Gram data directory.",
              }),
            ),
          ),
          Effect.mapError((error) =>
            error instanceof AgentUnavailable
              ? error
              : unavailableNaming("Codex couldn't open the thread", needs)(error),
          ),
        );
      const threadId = started.thread.id;
      const rpc = server.rpc;
      if (confined !== undefined) {
        // No turn has run, so nothing has reached a server yet; one still on refuses the session.
        const left = unconfinedServers(
          yield* listServerStatus(rpc, threadId).pipe(
            Effect.mapError(unavailable("Codex couldn't list its MCP servers")),
          ),
          o.mcp !== undefined,
        );
        if (left.length > 0) {
          return yield* new AgentUnavailable({
            agent: "codex",
            reason: "startup-failed",
            message: `This session may use no MCP server but Gram's, and Codex kept ${left.join(", ")} on. Turn ${left.length === 1 ? "it" : "them"} off in your Codex config to run it.`,
          });
        }
      }
      if (narrowedRead !== undefined) {
        // Check named exclusions too: a CLI that ignores an override must not bypass the lists.
        // Unknown plugin servers have no configured URL, so match their names against the lists.
        const kept = unconfinedServers(
          yield* listServerStatus(rpc, threadId).pipe(
            Effect.mapError(unavailable("Codex couldn't list its MCP servers")),
          ),
          o.mcp !== undefined,
        ).filter(
          (name) =>
            Object.hasOwn(leftOut, name) || (!configured.has(name) && listsLeaveOut(o, { name })),
        );
        if (kept.length > 0) {
          return yield* new AgentUnavailable({
            agent: "codex",
            reason: "startup-failed",
            message: `This workspace's connectors leave out ${kept.join(", ")}, and Codex kept ${kept.length === 1 ? "it" : "them"} on. Turn ${kept.length === 1 ? "it" : "them"} off in your Codex config, or change the workspace's Connectors, to run here.`,
          });
        }
      }

      const events = yield* Queue.unbounded<AgentEvent, Cause.Done>();
      const emit = (event: AgentEvent): void => {
        Queue.offerUnsafe(events, event);
      };
      const pending = new Map<RequestId, ServerRequest>();
      const run = yield* FiberSet.makeRuntime();
      let compactionTurnId: string | undefined;
      const cardUp = (): boolean =>
        [...pending.values()].some((request) => request.method !== "item/tool/requestUserInput");
      const diagnosticScope = JSON.stringify([home, o.model?.profileId]);
      const mapper = makeCodexMapper({
        threadId,
        freshSession: o.resumeId === undefined,
        diagnosticScope,
        diagnosticCwd: o.cwd,
        newMessageId: () => MessageId.make(newId()),
        answersApprovals: () => gated && gateAnswersInMode(mode) && !cardUp(),
        gateway: server.gateway,
        onCompaction: (phase) => {
          if (phase.phase === "started") compactionTurnId = phase.turnId;
          run(
            Effect.logInfo("codex compaction").pipe(
              Effect.annotateLogs({
                threadId: o.threadId,
                codexThreadId: threadId,
                ...phase,
              }),
            ),
          );
        },
      });
      let turnId: string | undefined;
      // Notifications and RPC replies share stdio but are consumed by separate fibers. A short
      // turn can complete before turn/start answers; its late reply must not make it active again.
      let completedTurnId: string | undefined;
      // A thread the app-server still has loaded takes none of `thread/resume`'s settings: reopened
      // under a gate it had not had, it kept `never` and ran a push unasked (measured on codex
      // 0.154.0; its developer instructions and config stay as first given, too). A turn's own
      // policy does apply, so a resumed session states it with its first turn.
      let policyChanged = o.resumeId !== undefined && o.fork !== true;
      let planned = false;

      const handleRequest = (request: ServerRequest) => {
        if (gated && gateVerdict(request, gateAnswersInMode(mode), level) === "accept") {
          run(
            rpc
              .respond(request.id, GATE_ACCEPT)
              .pipe(
                Effect.onError((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("codex gate response failed", cause),
                ),
              ),
          );
          return;
        }
        const card = toPendingRequest(request, mapper.changes, level ?? false);
        if (card === undefined) {
          emit({
            type: "notice",
            level: "warning",
            message: `Codex asked for ${request.method}, which Gram can't answer yet; declined.`,
          });
          run(
            rpc
              .respond(
                request.id,
                responseFor(request, { kind: "approval", decision: "deny", scope: "once" }),
              )
              .pipe(
                Effect.onError((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("codex decline response failed", cause),
                ),
              ),
          );
          return;
        }
        pending.set(card.id, request);
        // Codex's own `waitingOnApproval` flag came before the request and was kept back.
        if (gated && card.kind === "approval") {
          for (const event of mapper.awaitingApproval()) emit(event);
        }
        emit({ type: "request", request: card });
      };

      /** The token is stored by now; the thread's servers reload so this one connects with it. */
      const signedIn = (login: McpServerOauthLoginCompletedNotification) => {
        if (login.success) {
          run(
            rpc
              .request("config/mcpServer/reload", undefined)
              .pipe(
                Effect.onError((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Effect.logError("codex oauth reload failed", cause),
                ),
              ),
          );
          return;
        }
        emit({
          type: "notice",
          level: "warning",
          message: `Signing in to ${login.name} didn't finish${login.error ? `: ${login.error}` : "."}`,
        });
      };

      yield* Effect.addFinalizer(() => Effect.sync(() => Queue.endUnsafe(events)));
      yield* server.subscribe(threadId, {
        message: (message) => {
          if (isServerRequest(message)) return handleRequest(message);
          if (message.method === "thread/settings/updated") {
            const tier = message.params.threadSettings.serviceTier;
            emit({
              type: "speed",
              state: {
                speed:
                  tier === "priority" || tier === "fast"
                    ? "fast"
                    : tier === null || tier === "default"
                      ? "standard"
                      : "unknown",
              },
            });
          }
          if (message.method === "turn/started") turnId = message.params.turn.id;
          if (message.method === "turn/completed") {
            if (message.params.turn.id === compactionTurnId) {
              compactionTurnId = undefined;
              run(
                Effect.logInfo("codex compaction").pipe(
                  Effect.annotateLogs({
                    threadId: o.threadId,
                    codexThreadId: threadId,
                    turnId: message.params.turn.id,
                    phase: "turnCompleted",
                    at: Date.now(),
                    outcome: message.params.turn.status,
                  }),
                ),
              );
            }
            completedTurnId = message.params.turn.id;
            if (completedTurnId === turnId) turnId = undefined;
          }
          if (message.method === "mcpServer/oauthLogin/completed") signedIn(message.params);
          for (const event of mapper.map(message)) {
            if (event.type === "requestResolved") pending.delete(event.requestId);
            emit(event);
          }
        },
        exit: () => {
          for (const event of mapper.flush()) emit(event);
          emit({ type: "ended", reason: "exited" });
          Queue.endUnsafe(events);
        },
      });

      // The skills Codex finds for the folder: its own, the user's, the repo's and plugins'. Codex
      // has no slash commands of its own outside its TUI, so these and `/compact` are the list.
      const skills = yield* rpc.request("skills/list", { cwds: [o.cwd] }).pipe(
        Effect.flatMap((listed) =>
          Effect.try(() => {
            const byName = new Map<string, SlashCommand>();
            for (const skill of listed.data.flatMap((entry) => entry.skills)) {
              if (!skill.enabled || byName.has(skill.name)) continue;
              const description =
                skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
              byName.set(skill.name, { name: skill.name, description });
            }
            return byName;
          }),
        ),
        // A Codex without skills, or one answering in another shape, offers `/compact` alone.
        Effect.catch(() => Effect.succeed(new Map<string, SlashCommand>())),
      );
      for (const warning of server.warnings)
        emit({
          type: "notice",
          level: "warning",
          message: warning,
          startupDiagnostic: startupDiagnostic(diagnosticScope, "Codex startup", [warning]),
        });
      emit({
        type: "identity",
        agentSessionId: threadId,
        codexHome: home,
        model: started.model,
        tools: [],
        commands: [...(skills.has(COMPACT.name) ? [] : [COMPACT]), ...skills.values()],
      });
      if (started.serviceTier !== undefined || model?.speed !== undefined)
        emit({
          type: "speed",
          state: {
            speed:
              started.serviceTier === "priority" || started.serviceTier === "fast"
                ? "fast"
                : started.serviceTier === null || started.serviceTier === "default"
                  ? "standard"
                  : "unknown",
          },
        });
      emit({ type: "status", status: "idle" });

      const turnParams = (input: UserInput, messageId: string | undefined): TurnStartParams => {
        const currentModel =
          model === undefined || model.model === "default" ? started.model : model.model;
        const policy = policyFor(mode, gated);
        const plan = mode === "plan";
        // The collaboration mode sticks to the thread, so leaving plan mode has to be said too.
        const collaboration =
          plan || planned
            ? {
                collaborationMode: {
                  mode: plan ? ("plan" as const) : ("default" as const),
                  settings: {
                    model: currentModel,
                    reasoning_effort: model?.variant ?? null,
                    developer_instructions: null,
                  },
                },
              }
            : {};
        const params: TurnStartParams = {
          threadId,
          input: toInput(input),
          ...(messageId === undefined ? {} : { clientUserMessageId: messageId }),
          ...(model === undefined || model.model === "default" ? {} : { model: model.model }),
          ...(model?.variant === undefined ? {} : { effort: model.variant }),
          ...(model?.speed === undefined
            ? {}
            : { serviceTier: model.speed === "fast" ? "priority" : "default" }),
          ...(policyChanged
            ? {
                approvalPolicy: policy.approvalPolicy,
                ...reviewer,
                sandboxPolicy: sandboxPolicy(policy.sandbox, roots),
              }
            : {}),
          ...collaboration,
        };
        return params;
      };

      const refused = (what: string) => (error: { readonly message: string }) =>
        Effect.sync(() => {
          emit({ type: "notice", level: "error", message: `${what}: ${error.message}` });
          emit({ type: "turnEnd", reason: "error", error: error.message });
          emit({ type: "status", status: "idle" });
        });

      /** A skill is `$name` to Codex, which reads the skill in for the turn as its TUI does. */
      const asSkill = (input: UserInput): UserInput => {
        const name = /^\/(\S+)/.exec(input.text.trim())?.[1];
        return name !== undefined && skills.has(name)
          ? { ...input, text: `$${input.text.trim().slice(1)}` }
          : input;
      };

      const send = (input: UserInput, messageId?: string): Effect.Effect<void> => {
        const named = /^\/(\S+)(\s[\s\S]*)?$/.exec(input.text.trim());
        const name = named?.[1];
        if (name === COMPACT.name && named?.[2] === undefined && !skills.has(name)) {
          return Effect.gen(function* () {
            const requestedAt = Date.now();
            mapper.compactionRequested(true);
            yield* Effect.logInfo("codex compaction request").pipe(
              Effect.annotateLogs({
                threadId: o.threadId,
                codexThreadId: threadId,
                phase: "requested",
                at: requestedAt,
              }),
            );
            yield* rpc.request("thread/compact/start", { threadId }).pipe(
              Effect.tap(() =>
                Effect.logInfo("codex compaction request").pipe(
                  Effect.annotateLogs({
                    threadId: o.threadId,
                    codexThreadId: threadId,
                    phase: "acknowledged",
                    at: Date.now(),
                    requestMs: Math.max(0, Date.now() - requestedAt),
                  }),
                ),
              ),
              Effect.asVoid,
              Effect.catch((error) =>
                Effect.sync(() => mapper.compactionRequested(false)).pipe(
                  Effect.andThen(
                    Effect.logInfo("codex compaction request").pipe(
                      Effect.annotateLogs({
                        threadId: o.threadId,
                        codexThreadId: threadId,
                        phase: "rejected",
                        at: Date.now(),
                        requestMs: Math.max(0, Date.now() - requestedAt),
                      }),
                    ),
                  ),
                  Effect.andThen(refused("Codex didn't compact the thread")(error)),
                ),
              ),
            );
          });
        }
        const params = turnParams(asSkill(input), messageId);
        const sentMode = mode;
        return rpc.request("turn/start", params).pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              // A rejected send applied no settings. Keep the permission change for its retry;
              // a mode selected while this request was in flight also belongs to the next turn.
              if (sentMode === mode) policyChanged = false;
              // Collaboration settings stick too: a refused exit from plan mode must be retried.
              planned = sentMode === "plan";
              if (response.turn.id !== completedTurnId) turnId = response.turn.id;
            }),
          ),
          Effect.asVoid,
          Effect.catch(refused("Codex didn't accept the message")),
        );
      };

      const session: AgentSession = {
        ...(server.prepareForSwitch === undefined
          ? {}
          : { prepareForSwitch: server.prepareForSwitch }),
        ...(server.stopForSwitch === undefined ? {} : { stopForSwitch: server.stopForSwitch }),
        ...(acceptSwitchStartup === undefined
          ? {}
          : {
              acceptSwitchStartup: (attemptId: string) =>
                switchSessionLive && attemptId === o.switchStartup
                  ? acceptSwitchStartup
                  : Effect.fail(
                      new AgentUnavailable({
                        agent: "codex",
                        message: "Stale orchestrator switch startup.",
                      }),
                    ),
            }),
        configCurrent: server.configCurrent,
        configOwner: server,
        events: Stream.fromQueue(events),
        send: (input, options) => send(input, options?.messageId),
        // A steer joins the running turn or fails, never starting one: the runtime still counts its
        // turn as running (Codex's end can reach us first), so a turn started here is one it never
        // tracks, and a refused steer may have been taken. The runtime queues what fails.
        steer: (input) =>
          turnId === undefined
            ? Effect.die(new Error("Codex has no running turn to steer"))
            : rpc
                // Mid-turn `/compact` stays text: a compaction would be a turn of its own.
                .request("turn/steer", {
                  threadId,
                  expectedTurnId: turnId,
                  input: toInput(asSkill(input)),
                })
                .pipe(
                  Effect.asVoid,
                  Effect.catch((error) =>
                    Effect.die(new Error(`Codex refused the steer: ${error.message}`)),
                  ),
                ),
        interrupt: Effect.suspend(() =>
          turnId === undefined
            ? Effect.void
            : rpc.request("turn/interrupt", { threadId, turnId }).pipe(Effect.ignore),
        ).pipe(
          Effect.timeoutOrElse({
            duration: interruptTimeoutMs,
            orElse: () => Effect.fail(new InterruptHung({ timeoutMs: interruptTimeoutMs })),
          }),
        ),
        respond: (requestId, answer) =>
          Effect.suspend(() => {
            const request = pending.get(requestId);
            if (request === undefined) return Effect.void;
            pending.delete(requestId);
            return rpc.respond(request.id, responseFor(request, answer, level ?? false));
          }),
        setMode: (next) =>
          Effect.sync(() => {
            const [from, to] = [policyFor(mode, gated), policyFor(next, gated)];
            if (to.approvalPolicy !== from.approvalPolicy || to.sandbox !== from.sandbox) {
              policyChanged = true;
            }
            mode = next;
            emit({ type: "mode", mode: next });
          }),
        setModel: (next) =>
          Effect.gen(function* () {
            if (next.speed === "fast") {
              const problem = fastSelectionProblem(
                next,
                yield* listModels(
                  next.profileId === undefined ? {} : { profileId: next.profileId },
                ).pipe(Effect.orDie),
              );
              if (problem !== undefined) return yield* Effect.die(new Error(problem));
            }
            const speedChanged = model?.speed !== next.speed;
            model = next;
            if (speedChanged)
              emit({
                type: "speed",
                state: {
                  speed: "unknown",
                  detail: "Speed selection applies to the next turn; awaiting the CLI report.",
                },
              });
          }),
        connectors: {
          ...(confined === undefined ? reportedLists(o) : {}),
          status: listServerStatus(rpc, threadId).pipe(
            Effect.mapError(unavailable("Codex couldn't list its connectors")),
            Effect.map((statuses) =>
              statuses.map((status) =>
                toConnectorStatus(status, o.mcp !== undefined && status.name === APP_TOOLS_NAME),
              ),
            ),
          ),
          reconnect: () =>
            Effect.fail(new AgentUnavailable({ agent: "codex", message: CODEX_RECONNECT_REASON })),
          setEnabled: (name, enabled) =>
            Effect.suspend(() => {
              if (o.mcp !== undefined && name === APP_TOOLS_NAME) {
                return Effect.fail(
                  new AgentUnavailable({ agent: "codex", message: BUILT_IN_TOGGLE_REASON }),
                );
              }
              const next = new Map(serverOverrides.get(o.threadId));
              next.set(name, enabled);
              serverOverrides.set(o.threadId, next);
              return Effect.succeed("restart" as const);
            }),
          // Codex runs the whole flow: it listens on its own loopback port for the callback and
          // keeps the token in this app-server's credential store.
          authenticate: (name) =>
            rpc.request("mcpServer/oauth/login", { name, threadId }).pipe(
              Effect.mapError(unavailable(`Codex couldn't start signing in to ${name}`)),
              Effect.map(({ authorizationUrl }) => ({ authorizationUrl })),
            ),
        },
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
              agent: "codex",
              message: "This switch startup attempt was already used.",
            }),
          );
        const attempt = { delegated: false, notStarted: false };
        switchAttempts.set(id, attempt);
        return openSession(o).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && !attempt.delegated) attempt.notStarted = true;
            }),
          ),
        );
      });

    const listModels = (options: ListModelsOptions = {}) =>
      options.profileId === undefined
        ? Effect.gen(function* () {
            const server = yield* acquireHeld(servers.acquire(undefined, "user"));
            const account = yield* server.rpc
              .request("account/read", { refreshToken: false })
              .pipe(Effect.mapError(unavailable("Codex couldn't check its sign-in")));
            if (account.requiresOpenaiAuth && account.account === null) {
              return yield* new AgentUnavailable({
                agent: "codex",
                reason: "not-logged-in",
                message:
                  "Codex isn't signed in. Run `codex login` with your ChatGPT account, then re-check.",
              });
            }
            const models = new Map<string, AgentModel>();
            const cursors = new Set<string>();
            let cursor: string | null = null;
            do {
              const page: {
                readonly data: ReadonlyArray<Model>;
                readonly nextCursor: string | null;
              } = yield* server.rpc
                .request("model/list", {
                  includeHidden: false,
                  ...(cursor === null ? {} : { cursor }),
                })
                .pipe(Effect.mapError(unavailable("Codex couldn't list models")));
              for (const model of page.data)
                if (!model.hidden) models.set(model.id, catalogModel(model));
              cursor = page.nextCursor;
              if (cursor !== null && cursors.has(cursor)) {
                return yield* new AgentUnavailable({
                  agent: "codex",
                  message: "Codex returned a repeated model cursor. Re-check or update the CLI.",
                });
              }
              if (cursor !== null) cursors.add(cursor);
            } while (cursor !== null);
            return [...models.values()];
          }).pipe(
            Effect.timeoutOrElse({
              duration: 30_000,
              orElse: () =>
                Effect.fail(
                  new AgentUnavailable({
                    agent: "codex",
                    message: "Codex model discovery timed out. Re-check or restart the CLI.",
                  }),
                ),
            }),
            Effect.scoped,
          )
        : gateway
            .credentials(options.profileId, "codex")
            .pipe(Effect.map(({ profile }) => gatewayAgentModels(profile.models, "codex")));

    /**
     * Persist on the user's home without reloading any loaded thread. Retire acquisition caches
     * afterwards: fresh children (gateway copies included) read the changed config, while held
     * siblings keep their child. An interrupted/failed reply may follow a persisted write, so
     * cache retirement also runs on that exit; it never forces held sessions to stop.
     */
    const writeServer = (name: string, entry: Record<string, unknown> | undefined) =>
      Effect.gen(function* () {
        const user = yield* acquireHeld(servers.acquire(undefined, "user"));
        yield* user.rpc.request("config/batchWrite", serverEdit(name, entry)).pipe(
          Effect.mapError((error) => unavailable("Codex didn't write its config")(error)),
          Effect.ensuring(servers.retireAll),
        );
      }).pipe(Effect.scoped);

    // The catalog the profile's app-server runs on, gateway clones included; hidden entries count,
    // since Codex runs them with their own settings too.
    // A listing that fails part way says nothing, rather than marking the later pages unknown.
    const knownModels = (profileId: ProfileId) =>
      Effect.gen(function* () {
        const { rpc } = yield* acquireHeld(servers.acquire(profileId, "gateway"));
        const ids = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: {
            readonly data: ReadonlyArray<{ readonly id: string }>;
            readonly nextCursor: string | null;
          } = yield* rpc.request("model/list", { includeHidden: true, cursor });
          for (const model of page.data) ids.add(model.id);
          cursor = page.nextCursor;
        } while (cursor !== null);
        return ids as ReadonlySet<string> | undefined;
      }).pipe(
        Effect.scoped,
        Effect.catchDefect(() => Effect.succeed(undefined)),
        Effect.orElseSucceed(() => undefined),
      );

    return {
      kind: "codex",
      nativeGateReady: servers.nativeGateReady ?? Effect.succeed(false),
      supportsWorkspaceSwitch: process.platform !== "win32",
      checkWorkspaceSwitch: Effect.gen(function* () {
        const server = yield* acquireHeld(servers.acquire(undefined, "user"));
        const account = yield* server.rpc
          .request("account/read", { refreshToken: false })
          .pipe(Effect.mapError(unavailable("Codex couldn't check its sign-in")));
        if (!account.requiresOpenaiAuth || account.account?.type !== "chatgpt")
          return yield* new AgentUnavailable({
            agent: "codex",
            reason: account.account === null ? "not-logged-in" : "api-key-auth",
            message:
              "Switching requires the installed Codex CLI's ChatGPT subscription login. Check its sign-in and try again.",
          });
      }).pipe(
        Effect.timeoutOrElse({
          duration: 30_000,
          orElse: () =>
            Effect.fail(
              new AgentUnavailable({
                agent: "codex",
                message: "Codex sign-in readiness timed out. No orchestrator switch was started.",
              }),
            ),
        }),
        Effect.scoped,
      ),
      switchAttemptReceipt: (id) =>
        switchAttempts.get(id)?.notStarted
          ? Effect.succeed("notStarted" as const)
          : (servers.switchAttemptReceipt?.(id) ?? Effect.succeed(undefined)),
      switchAttemptReleased: (id) =>
        switchAttempts.get(id)?.notStarted
          ? Effect.succeed(true)
          : (servers.switchAttemptReleased?.(id) ?? Effect.succeed(false)),
      capabilities: CODEX_CAPABILITIES,
      open,
      listModels,
      readSubscriptionLimits: Effect.gen(function* () {
        const server = yield* acquireHeld(servers.acquire(undefined, "user"));
        const account = yield* server.rpc.request("account/read", { refreshToken: false });
        // API keys and gateways never stand in for a subscription; the CLI owns authentication.
        if (account.account === null || account.account.type !== "chatgpt") return [];
        return codexSubscriptionLimits(
          yield* server.rpc.request("account/rateLimits/read", undefined),
        );
      }).pipe(
        Effect.timeoutOrElse({
          duration: 30_000,
          orElse: () => Effect.fail(new Error("Usage query timed out")),
        }),
        Effect.mapError(
          () =>
            new AgentUnavailable({
              agent: "codex",
              reason: "startup-failed",
              message: "Codex could not read subscription limits.",
            }),
        ),
        Effect.scoped,
      ),
      knownModels,
      mcpConfig: {
        add: ({ name }, server) => {
          const native = codexServerEntry(server);
          return "unsupported" in native
            ? Effect.fail(new AgentUnavailable({ agent: "codex", message: native.unsupported }))
            : writeServer(name, native.entry);
        },
        remove: ({ name }) => writeServer(name, undefined),
        list: ({ cwd, checkSignIn }) =>
          Effect.gen(function* () {
            const { rpc } = yield* acquireHeld(servers.acquire(undefined, "user"));
            const read = yield* rpc.request("config/read", {
              includeLayers: false,
              ...(cwd === undefined ? {} : { cwd }),
            });
            // Listing statuses makes Codex start and connect every server, so only when asked to.
            const auth = checkSignIn
              ? new Map((yield* listServerStatus(rpc)).map((s) => [s.name, s.authStatus]))
              : undefined;
            return configuredServers(read, auth);
          }).pipe(Effect.scoped, Effect.mapError(asUnavailable)),
        // Codex keeps the token in the OS keyring by server name and URL, so a sign-in made on the
        // user's app-server holds for the gateway home's too.
        // It runs on beside the host until the user is done, bounded by `SIGN_IN_WAIT`.
        signIn: (name) =>
          Effect.gen(function* () {
            const started = yield* Deferred.make<
              { readonly authorizationUrl: string },
              AgentUnavailable
            >();
            yield* Effect.forkIn(
              threadlessSignIn(servers, name, started).pipe(
                Effect.flatMap((succeeded) =>
                  succeeded ? Queue.offer(signedInQueue, name) : Effect.void,
                ),
              ),
              hostScope,
            );
            return yield* Deferred.await(started);
          }),
        signedIn: Stream.fromQueue(signedInQueue),
      },
      invalidateProfile: (profileId) => servers.invalidate(profileId),
      invalidateRuntime: servers.retireAll,
      reloadConfig: servers.retire,
      reloadAllConfig: servers.retireAll,
      // The user's own CODEX_HOME and the gateway home each hold their own threads.
      listSessions: ({ cwd, limit }) =>
        Effect.forEach(servers.homes, (home) =>
          Effect.scoped(
            Effect.gen(function* () {
              const server = yield* servers.history(home);
              const threads = yield* listThreads(server.rpc, cwd, limit).pipe(
                Effect.mapError(unavailable("Codex couldn't list sessions")),
              );
              return threads.map((t): AgentSessionSummary => ({
                ...toSessionSummary(t),
                codexHome: home,
              }));
            }),
          ),
        ).pipe(
          Effect.map((lists) => {
            const all = lists.flat().toSorted((a, b) => b.updatedAt - a.updatedAt);
            return limit === undefined ? all : all.slice(0, limit);
          }),
        ),
      // Codex reads any thread of a home whatever folder asks, so the folder is checked here. An id
      // a home doesn't have is an error from `thread/read` ("thread not loaded", "invalid thread
      // id"), which only means: look in the other home.
      readSession: ({ cwd, agentSessionId, limit }) =>
        Effect.gen(function* () {
          for (const home of servers.homes) {
            const messages = yield* Effect.scoped(
              Effect.gen(function* () {
                const server = yield* servers.history(home);
                const found = yield* server.rpc
                  .request("thread/read", { threadId: agentSessionId, includeTurns: false })
                  .pipe(Effect.option);
                if (Option.isNone(found)) return undefined;
                const { thread } = found.value;
                if (pathKey(thread.cwd) !== pathKey(cwd) || thread.parentThreadId !== null) {
                  return undefined;
                }
                const turns = yield* readTurns(server.rpc, agentSessionId, limit).pipe(
                  Effect.mapError(unavailable("Codex couldn't read the session")),
                );
                return toCodexTranscript(turns);
              }),
            );
            if (messages !== undefined) {
              return {
                agentSessionId,
                cwd,
                messages: limit === undefined ? messages : messages.slice(0, limit),
              };
            }
          }
          return yield* new NotFound({
            entity: "session",
            id: agentSessionId,
            message: `No Codex session ${agentSessionId} in ${cwd}.`,
          });
        }),
      deleteSession: ({ cwd, agentSessionId }) =>
        Effect.gen(function* () {
          for (const home of servers.homes) {
            const deleted = yield* Effect.scoped(
              Effect.gen(function* () {
                const server = yield* servers.history(home);
                const threads = yield* listThreads(server.rpc, cwd, 500).pipe(
                  Effect.mapError(unavailable("Codex couldn't list sessions")),
                );
                if (!threads.some((t) => t.id === agentSessionId)) return false;
                yield* server.rpc
                  .request("thread/delete", { threadId: agentSessionId })
                  .pipe(Effect.mapError(unavailable("Codex couldn't delete the session")));
                return true;
              }),
            );
            if (deleted) return;
          }
          return yield* new NotFound({
            entity: "session",
            id: agentSessionId,
            message: `No Codex session ${agentSessionId} in ${cwd}.`,
          });
        }),
      helper: makeCodexHelper(config.helperServers ?? {}, gateway),
    } satisfies AgentHost;
  });

export const CodexHostLayer = (
  config: CodexHostConfig = {},
): Layer.Layer<CodexHost, never, CodexServers | GatewayKeyProvider> =>
  Layer.effect(CodexHost)(makeCodexHost(config));

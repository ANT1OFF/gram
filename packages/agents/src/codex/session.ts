import { codexSubscriptionLimits } from "./limits.ts";
import {
  AgentUnavailable,
  AnswerUndelivered,
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
  type BrowserScope,
  type BrowserSurfaces,
  type OpenSessionOptions,
  type OutwardGate,
} from "../host.ts";
import { codexServerEntry, describeCodexEntry } from "../mcp-native.ts";
import { listsLeaveOut, narrowsMcp, reportedLists } from "../mcp-lists.ts";
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
import {
  confinedConfig,
  leftOutConfig,
  loadedProjectLayers,
  switchedOff,
  unconfinedServers,
  tmpConfig,
} from "./thread-config.ts";
import { CodexServers, SERVER_WIDE, type CodexServer, type CodexServersConfig } from "./servers.ts";
import { toCodexTranscript } from "./transcript.ts";
import { codexAutoReviewSupported } from "./version.ts";

/**
 * What a Codex thread supports.
 * - `rewind: "history"`: `thread/revert` drops later turns from the history only; files stay as
 *   they are (Codex has no file snapshots).
 * - `steer`: `turn/steer` adds input to the running turn, answered at the next model call. It
 *   cancels nothing. Codex has no interrupting steer (`steerInterrupt`), so Gram's `interrupt`
 *   delivery reaches a Codex thread as a steer.
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
 * Codex's approval policy, sandbox and approvals reviewer for a permission mode, and what changes
 * when the session is under the outward gate (`OpenSessionOptions.outwardGate`) or its CLI takes the
 * automatic reviewer (`codexAutoReviewSupported`). Policy and sandbox measured on codex 0.154.0:
 *
 * | Mode                             | Ungated                          | Gated                              |
 * | -------------------------------- | -------------------------------- | ---------------------------------- |
 * | `bypassPermissions`              | `never` + `danger-full-access`   | `untrusted` + `danger-full-access` |
 * | `auto`                           | `on-request` + `workspace-write` | the same                           |
 * | `default`, `acceptEdits`, `plan` | `on-request` + `workspace-write` | the same                           |
 * | `dontAsk`                        | `never` + `workspace-write`      | the same                           |
 *
 * The reviewer (who answers an approval request) is `user` in every gated session, and in every
 * ungated one on a CLI that has the automatic reviewer, except `auto` there: `auto_review`, a Codex
 * subagent that approves or denies each request and hands a denial back to the agent, which goes on
 * another way or says what stayed blocked. Nothing reaches the client then, and the user is asked
 * only by the agent's own words. That is Gram's Auto. On an older CLI the reviewer is left to the
 * home's config, as before it existed, and `auto` is not Auto: the session reports `default`
 * (`autoAvailable`).
 *
 * - Bypass: `never` with full access runs `git push` with no request, so a gated session never sends
 *   it. Under `untrusted` Codex asks about every command and every patch with the whole command line
 *   in the request; the adapter accepts all but the outward commands unseen (`gateVerdict`), and
 *   those become a once-only card.
 * - The sandboxed modes: the sandbox has no network, so a plain push fails, and an escalated one is
 *   a request whose card shows the command, once-only. Nothing is accepted unseen here: in a sandbox
 *   an escalation request differs from a plain one by nothing but a `reason` the model writes, so
 *   accepting on the command alone would grant every escalation.
 * - Gated `auto`: the automatic reviewer would answer the outward request in the user's place, and
 *   the gate never see it, so a gated session has no Auto and names the user whatever the home's
 *   config says.
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
  autoReviewer = false,
): {
  readonly approvalPolicy: AskForApproval;
  readonly sandbox: SandboxMode;
  readonly approvalsReviewer?: ApprovalsReviewer;
} => {
  const gated = gateLevel(outwardGate) !== undefined;
  const reviewer: { readonly approvalsReviewer?: ApprovalsReviewer } = gated
    ? { approvalsReviewer: "user" }
    : autoReviewer
      ? { approvalsReviewer: mode === "auto" ? "auto_review" : "user" }
      : {};
  switch (mode) {
    case "bypassPermissions":
      return {
        approvalPolicy: gated ? "untrusted" : "never",
        sandbox: "danger-full-access",
        ...reviewer,
      };
    case "dontAsk":
      return { approvalPolicy: "never", sandbox: "workspace-write", ...reviewer };
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write", ...reviewer };
  }
};

/**
 * Whether `auto` is Codex's automatic reviewer here: ungated, on a CLI that has it. Elsewhere a
 * session opened or switched to `auto` runs and reports `default`, which orchestration moves to
 * `bypassPermissions` (`modeAfterDowngrade`).
 */
export const autoAvailable = (outwardGate: boolean | OutwardGate, autoReviewer: boolean): boolean =>
  gateLevel(outwardGate) === undefined && autoReviewer;

/**
 * Whether the outward gate can hold in `mode`: every mode but `dontAsk`, whose `never` policy leaves
 * Codex nothing to ask with. For the server to decide which modes a gated thread may be put in.
 */
export const gateHoldsInMode = (mode: PermissionMode): boolean => mode !== "dontAsk";

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

const toConnectorStatus = (status: McpServerStatus, builtIn: boolean): ConnectorStatus => ({
  name: status.name,
  status: status.runtimeStatus === null ? "pending" : CONNECTION_STATE[status.runtimeStatus],
  ...(status.toolsError === null ? {} : { error: status.toolsError }),
  ...(builtIn || status.pluginId !== null ? {} : { scope: "user" }),
  reconnectUnavailable: CODEX_RECONNECT_REASON,
  ...(builtIn ? { builtIn: true, toggleUnavailable: BUILT_IN_TOGGLE_REASON } : {}),
});

const serverEdit = (name: string, entry: Record<string, unknown> | undefined) => ({
  edits: [
    {
      keyPath: `mcp_servers.${name}`,
      value: (entry ?? null) as JsonValue,
      mergeStrategy: "replace" as const,
    },
  ],
  reloadUserConfig: false,
});

const asUnavailable = (error: AgentUnavailable | { readonly message: string }) =>
  error instanceof AgentUnavailable
    ? error
    : new AgentUnavailable({ agent: "codex", message: error.message });

const SIGN_IN_WAIT = Duration.minutes(15);

const threadlessSignIn = (
  servers: CodexServers["Service"],
  name: string,
  started: Deferred.Deferred<{ readonly authorizationUrl: string }, AgentUnavailable>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* acquireHeld(servers.acquire(undefined, "user"));
      const done = yield* Deferred.make<boolean>();
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
    Effect.ensuring(
      Deferred.fail(
        started,
        new AgentUnavailable({ agent: "codex", message: "Codex stopped before signing in" }),
      ),
    ),
  );

const SIGNED_IN: Readonly<Partial<Record<McpAuthStatus, boolean>>> = {
  notLoggedIn: false,
  oAuth: true,
};

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

/**
 * The plugins that bring Codex computer use (codex-cli 0.167.1, the ChatGPT app's bundle):
 * `unified-computer-use` serves `cua_repl`, which drives the user's browsers and Mac apps; the
 * others carry its Chrome, in-app browser and desktop skills. Naming one that isn't installed is
 * harmless.
 */
export const COMPUTER_USE_PLUGINS: ReadonlyArray<string> = [
  "unified-computer-use@openai-bundled",
  "computer-use@openai-bundled",
  "chrome@openai-bundled",
  "browser@openai-bundled",
];

const COMPUTER_USE_SERVERS: ReadonlySet<string> = new Set([
  "node_repl",
  "cua_repl",
  "computer-use",
]);

const isComputerUseServer = (name: string, table: unknown): boolean => {
  if (COMPUTER_USE_SERVERS.has(name)) return true;
  const command =
    typeof table === "object" && table !== null && "command" in table ? table.command : undefined;
  return (
    typeof command === "string" &&
    (command.includes("SkyComputerUseClient") || command.includes("/cua_node/"))
  );
};

/**
 * What a thread not given the browser turns off: each computer-use plugin, and each configured
 * server `read` names that is computer use (`node_repl`, the old standalone client). Only servers
 * the config has are named, since a table with nothing but `enabled` fails the whole config
 * ("invalid transport"), a plugin's server included; the plugin's own switch takes that one away.
 * Verified on codex-cli 0.167.1: `cua_repl` is gone from the thread and `node_repl` disabled,
 * every other server as it was.
 */
export const computerUseOff = (
  read: ConfigReadResponse | undefined,
): {
  readonly plugins: Record<string, { enabled: false }>;
  readonly servers: Record<string, { enabled: boolean }>;
} => {
  const tables = read?.config["mcp_servers"];
  const configured =
    typeof tables === "object" && tables !== null && !Array.isArray(tables)
      ? Object.entries(tables)
      : [];
  return {
    plugins: Object.fromEntries(COMPUTER_USE_PLUGINS.map((id) => [id, { enabled: false }])),
    servers: switchedOff(
      configured.filter(([name, table]) => isComputerUseServer(name, table)).map(([name]) => name),
    ),
  };
};

/**
 * What a thread given the browser turns off for the surfaces it wasn't given
 * (`OpenSessionOptions.browserSurfaces`): each one's skills plugin, and Codex's own access policy
 * where it has one. Mac apps are denied by default (`computer_use.default_app_access`), and with
 * neither browser, every site is (`browser_use.default_origin_policy`). `cua_repl` itself serves
 * every surface, so with one browser kept the other loses only its skills. Not verified live.
 */
export const surfacesOff = (
  surfaces: BrowserSurfaces,
): {
  readonly plugins: Record<string, { enabled: false }>;
  readonly config: {
    readonly computer_use?: { readonly default_app_access: "deny" };
    readonly browser_use?: { readonly default_origin_policy: { readonly access: "deny" } };
  };
} => ({
  plugins: Object.fromEntries(
    [
      ...(surfaces.chrome ? [] : ["chrome@openai-bundled"]),
      ...(surfaces.inApp ? [] : ["browser@openai-bundled"]),
      ...(surfaces.apps ? [] : ["computer-use@openai-bundled"]),
    ].map((id) => [id, { enabled: false }]),
  ),
  config: {
    ...(surfaces.apps ? {} : { computer_use: { default_app_access: "deny" } }),
    ...(surfaces.chrome || surfaces.inApp
      ? {}
      : { browser_use: { default_origin_policy: { access: "deny" } } }),
  },
});

/**
 * Codex's own access policy for a thread whose browser is limited
 * (`OpenSessionOptions.browserScope`): every site but the listed ones denied
 * (`browser_use.origins`, each host as its `https://` origin, a local one as `http://` too), and
 * every Mac app but the listed bundle ids (`computer_use.macos.bundle_ids`). Not verified live.
 */
export const scopeConfig = (
  scope: BrowserScope,
): {
  readonly browser_use?: {
    readonly default_origin_policy: { readonly access: "deny" };
    readonly origins: Record<string, { access: "allow" }>;
  };
  readonly computer_use?: {
    readonly default_app_access: "deny";
    readonly macos: { readonly bundle_ids: Record<string, "allow"> };
  };
} => ({
  ...(scope.sites === undefined || scope.sites.length === 0
    ? {}
    : {
        browser_use: {
          default_origin_policy: { access: "deny" },
          origins: Object.fromEntries(
            scope.sites
              .flatMap((site) =>
                /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(site)
                  ? [`https://${site}`, `http://${site}`]
                  : [`https://${site}`],
              )
              .map((origin) => [origin, { access: "allow" }]),
          ),
        },
      }),
  ...(scope.apps === undefined || scope.apps.length === 0
    ? {}
    : {
        computer_use: {
          default_app_access: "deny",
          macos: { bundle_ids: Object.fromEntries(scope.apps.map((id) => [id, "allow"])) },
        },
      }),
});

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

const COMPACT: SlashCommand = {
  name: "compact",
  description: "Summarize the conversation to free up context",
};

const toInput = (input: UserInput): TurnStartParams["input"] => [
  { type: "text", text: promptText(input), text_elements: [] },
];

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

const LIST_MAX_PAGES = 20;

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

const HISTORY_PAGE_TURNS = 100;
const HISTORY_MAX_PAGES = 50;

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
export const codexHomeFor = (
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

interface ThreadSettings {
  readonly cwd: string;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer?: ApprovalsReviewer;
  readonly sandbox: SandboxMode;
  readonly config?: NonNullable<ThreadStartParams["config"]>;
  readonly developerInstructions?: string;
}

export const makeCodexHost = (
  config: CodexHostConfig = {},
): Effect.Effect<AgentHost, never, CodexServers | GatewayKeyProvider | Scope.Scope> =>
  Effect.gen(function* () {
    const servers = yield* CodexServers;
    const hostScope = yield* Effect.scope;
    const gateway = yield* GatewayKeyProvider;
    const newId = config.newId ?? randomUUID;
    const interruptTimeoutMs = config.interruptTimeoutMs ?? 5_000;
    const serverOverrides = new Map<string, Map<string, boolean>>();
    const signedInQueue = yield* Queue.unbounded<string>();

    const switchAttempts = new Map<string, { delegated: boolean; notStarted: boolean }>();
    const openSession = Effect.fnUntraced(function* (o: OpenSessionOptions) {
      if (o.dreamFilesOnly === true)
        return yield* new AgentUnavailable({
          agent: "codex",
          reason: "startup-failed",
          message:
            "Codex memory updates are unavailable: this transport cannot disable every native tool while allowing only the bounded memory update file bridge. Choose Claude Code.",
        });
      if (o.audience === "dream" && (o.dreamGuided !== true || o.mcp === undefined))
        return yield* new AgentUnavailable({
          agent: "codex",
          reason: "startup-failed",
          message:
            "A guided Codex memory update requires its explicit mode and the bounded memory update file bridge.",
        });
      const home = codexHomeFor(o);
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
      if (o.switchStartup !== undefined) switchAttempts.get(o.switchStartup)!.delegated = true;
      if (o.waitForPreviousSession !== undefined && o.resumeId !== undefined && o.fork !== true) {
        const resolver = yield* servers.acquire(o.model?.profileId, home, sessionPartitionId);
        yield* resolver.waitForThreadExit(o.resumeId, o.waitForPreviousSession.onWait);
      }
      const server = yield* acquireHeld(
        servers.acquire(o.model?.profileId, home, sessionPartitionId, o.switchStartup),
      );
      if (home === "owned" && server.ownProvider === undefined) {
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
      const autoReviewer = home !== "gateway" && codexAutoReviewSupported(server.cliVersion);
      const runnable = (wanted: PermissionMode): PermissionMode =>
        wanted === "auto" && !autoAvailable(gated, autoReviewer) ? "default" : wanted;
      let mode: PermissionMode = runnable(o.permissionMode ?? "default");
      const downgradedAtOpen = mode !== (o.permissionMode ?? "default");
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
      if (o.untrustedTree === true) {
        const loaded = loadedProjectLayers(
          yield* server.rpc
            .request("config/read", { includeLayers: true, cwd: o.cwd })
            .pipe(Effect.mapError(unavailableNaming("Codex couldn't read its config", needs))),
        );
        if (loaded === undefined || loaded.length > 0)
          return yield* new AgentUnavailable({
            agent: "codex",
            reason: "startup-failed",
            message:
              loaded === undefined
                ? "This checkout is someone else's code, and this Codex doesn't say which project settings it would load. Update Codex, or use Claude Code, to run here."
                : `This checkout is someone else's code, and your Codex config trusts its ${loaded.join(", ")}, so Codex would run the settings in it. Remove that project's trust from your Codex config, or use Claude Code, to run here.`,
          });
      }
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
      const noSurface =
        o.browserSurfaces !== undefined &&
        !o.browserSurfaces.chrome &&
        !o.browserSurfaces.inApp &&
        !o.browserSurfaces.apps;
      const browserOff =
        confined === undefined &&
        o.browser !== undefined &&
        !(o.browser && home === "user" && !noSurface);
      const lent = confined === undefined && !browserOff && o.browser === true;
      const promptsOnce = lent && o.browserAsk === true;
      const narrowedSurfaces =
        lent && o.browserSurfaces !== undefined ? surfacesOff(o.browserSurfaces) : undefined;
      const narrowedRead =
        confined === undefined && (narrowsMcp(o) || o.mcpServer !== undefined || browserOff)
          ? yield* server.rpc
              .request("config/read", { includeLayers: false, cwd: o.cwd })
              .pipe(
                Effect.mapError(unavailableNaming("Codex couldn't read its MCP servers", needs)),
              )
          : undefined;
      const noComputerUse = browserOff ? computerUseOff(narrowedRead) : undefined;
      const leftOut = {
        ...(narrowedRead === undefined
          ? {}
          : leftOutConfig(narrowedRead, o, o.mcp === undefined ? undefined : APP_TOOLS_NAME)),
        ...noComputerUse?.servers,
      };
      const tables = narrowedRead?.config["mcp_servers"];
      const configured = new Set(
        typeof tables === "object" && tables !== null ? Object.keys(tables) : [],
      );
      if (o.mcpServer !== undefined && confined === undefined && configured.has(o.mcpServer.name)) {
        return yield* new AgentUnavailable({
          agent: "codex",
          reason: "startup-failed",
          message: `This session is given an MCP server named ${o.mcpServer.name}, and Codex's config here already has one by that name. Rename or remove it in the Codex config to run here.`,
        });
      }
      const overrides = serverOverrides.get(o.threadId) ?? new Map<string, boolean>();
      const mcpServers = {
        ...confined?.mcp_servers,
        ...leftOut,
        ...Object.fromEntries(
          [...overrides]
            .filter(([name, enabled]) => !enabled || (confined === undefined && !(name in leftOut)))
            .map(([name, enabled]) => [name, { enabled }]),
        ),
        ...(o.mcpServer === undefined || confined !== undefined
          ? {}
          : { [o.mcpServer.name]: { enabled: true, url: o.mcpServer.url } }),
        ...(o.mcp === undefined
          ? {}
          : {
              [APP_TOOLS_NAME]: {
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
              ...(server.ownProvider === undefined
                ? {
                    model_provider: "openai",
                    openai_base_url: "https://chatgpt.com/backend-api/codex",
                    forced_login_method: "chatgpt",
                    cli_auth_credentials_store: "file",
                  }
                : { model_provider: server.ownProvider }),
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
        ...(noComputerUse === undefined ? {} : { plugins: noComputerUse.plugins }),
        ...(narrowedSurfaces === undefined || Object.keys(narrowedSurfaces.plugins).length === 0
          ? {}
          : { plugins: narrowedSurfaces.plugins }),
        ...(lent && o.browserScope !== undefined ? scopeConfig(o.browserScope) : {}),
        ...narrowedSurfaces?.config,
        ...(confined === undefined ? {} : { apps: confined.apps, features: confined.features }),
        ...(roots.length === 0 ? {} : { sandbox_workspace_write: { writable_roots: [...roots] } }),
        ...tmpConfig(o.tmpDir),
      };
      const settings: ThreadSettings = {
        cwd: o.cwd,
        ...(home === "owned"
          ? {
              modelProvider: server.ownProvider ?? "openai",
              allowProviderModelFallback: false,
            }
          : {}),
        ...(model === undefined || model.model === "default" ? {} : { model: model.model }),
        ...(model?.speed === undefined
          ? {}
          : { serviceTier: model.speed === "fast" ? "priority" : "default" }),
        ...policyFor(mode, gated, autoReviewer),
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
        const kept = unconfinedServers(
          yield* listServerStatus(rpc, threadId).pipe(
            Effect.mapError(unavailable("Codex couldn't list its MCP servers")),
          ),
          o.mcp !== undefined,
        ).filter(
          (name) =>
            name !== o.mcpServer?.name &&
            (Object.hasOwn(leftOut, name) || (!configured.has(name) && listsLeaveOut(o, { name }))),
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
      const answersItself = (): boolean =>
        (gated && gateAnswersInMode(mode)) ||
        (mode === "auto" && autoAvailable(gated, autoReviewer));
      if (downgradedAtOpen) emit({ type: "mode", mode });
      const pending = new Map<RequestId, ServerRequest>();
      const run = yield* FiberSet.makeRuntime();
      let compactionTurnId: string | undefined;
      const cardUp = (): boolean =>
        [...pending.values()].some((request) => request.method !== "item/tool/requestUserInput");
      const diagnosticScope = JSON.stringify([home, o.model?.profileId]);
      const idScope = newId();
      const mapper = makeCodexMapper({
        requestScope: idScope,
        threadId,
        freshSession: o.resumeId === undefined,
        diagnosticScope,
        diagnosticCwd: o.cwd,
        newMessageId: () => MessageId.make(newId()),
        answersApprovals: () => !cardUp() && (answersItself() || mapper.autoReviewing()),
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
      let completedTurnId: string | undefined;
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
        const card = toPendingRequest(
          request,
          idScope,
          mapper.changes,
          level ?? false,
          promptsOnce,
        );
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
        if (card.kind === "approval" && (gated || answersItself() || mapper.autoReviewing())) {
          for (const event of mapper.awaitingApproval()) emit(event);
        }
        emit({ type: "request", request: card });
      };

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
        const policy = policyFor(mode, gated, autoReviewer);
        const plan = mode === "plan";
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
                ...(policy.approvalsReviewer === undefined
                  ? {}
                  : { approvalsReviewer: policy.approvalsReviewer }),
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
              if (sentMode === mode) policyChanged = false;
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
        steer: (input) =>
          turnId === undefined
            ? Effect.die(new Error("Codex has no running turn to steer"))
            : rpc
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
            return rpc
              .respond(request.id, responseFor(request, answer, level ?? false, promptsOnce))
              .pipe(
                Effect.catchDefect(() =>
                  Effect.fail(
                    new AnswerUndelivered({
                      message: "Codex did not receive the answer. Try again.",
                    }),
                  ),
                ),
                Effect.tap(() => Effect.sync(() => pending.delete(requestId))),
              );
          }),
        setMode: (next) =>
          Effect.sync(() => {
            const runs = runnable(next);
            const [from, to] = [
              policyFor(mode, gated, autoReviewer),
              policyFor(runs, gated, autoReviewer),
            ];
            if (
              to.approvalPolicy !== from.approvalPolicy ||
              to.sandbox !== from.sandbox ||
              to.approvalsReviewer !== from.approvalsReviewer
            ) {
              policyChanged = true;
            }
            mode = runs;
            emit({ type: "mode", mode: runs });
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

    const writeServer = (name: string, entry: Record<string, unknown> | undefined) =>
      Effect.gen(function* () {
        const user = yield* acquireHeld(servers.acquire(undefined, "user"));
        yield* user.rpc.request("config/batchWrite", serverEdit(name, entry)).pipe(
          Effect.mapError((error) => unavailable("Codex didn't write its config")(error)),
          Effect.ensuring(servers.retireAll),
        );
      }).pipe(Effect.scoped);

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
        return ids;
      }).pipe(
        Effect.scoped,
        Effect.catchDefect(() => Effect.succeed(undefined)),
        Effect.orElseSucceed(() => undefined),
      );

    return {
      kind: "codex",
      nativeGateReady: servers.nativeGateReady ?? Effect.succeed(false),
      autoReviewReady: servers.autoReviewReady ?? Effect.succeed(false),
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
            const auth = checkSignIn
              ? new Map((yield* listServerStatus(rpc)).map((s) => [s.name, s.authStatus]))
              : undefined;
            return configuredServers(read, auth);
          }).pipe(Effect.scoped, Effect.mapError(asUnavailable)),
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

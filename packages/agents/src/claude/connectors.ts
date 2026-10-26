import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import {
  AgentUnavailable,
  awaitsSignIn,
  presentableUrl,
  type ClaudeAiConnector,
  type ConnectorTool,
} from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BUILT_IN_TOGGLE_REASON,
  type AgentConnectors,
  type ConnectorSignInStart,
  type ConnectorStatus,
  type OpenSessionOptions,
} from "../host.ts";
import { APP_TOOL_SERVER } from "./apptools.ts";
import { DEFAULT_SIGN_IN_HINT } from "./mapper.ts";

/** What a thread says when the SDK in use can't start a sign-in, so `/mcp` is the only way. */
export const CLAUDE_SIGN_IN_HINT =
  "Claude Code signs in from its own menu: run claude in a terminal, open /mcp and sign in, then reconnect here.";

/**
 * The SDK's `mcp_authenticate` control request, which Claude Code's changelog announces for the SDK
 * (2.1.121) and the SDK's `Query` implements, but which its typings leave out (0.3.284). Claude
 * Code runs the whole OAuth flow: it registers the client, listens for the callback on its own
 * loopback port, stores the token where a terminal `claude` reads it, and reconnects the server.
 */
interface McpAuthenticator {
  readonly mcpAuthenticate: (serverName: string) => Promise<unknown>;
}

/**
 * Its answer: the page to open when the user has something to do, and whether Claude Code waits
 * for the callback itself. A claude.ai connector's page is claude.ai's, which calls nobody back.
 */
const AuthenticateResponse = Schema.Struct({
  authUrl: Schema.optionalKey(Schema.String),
  callbackExpected: Schema.optionalKey(Schema.Boolean),
});

/** The page a sign-in may send the browser to: a web page, never a file or a custom scheme. */
const webPage = (url: string) => /^https?:\/\//i.test(url);

/** How long a claude.ai connector's sign-in is watched for, and how often it is retried. */
const HOSTED_SIGN_IN_WAIT_MS = 5 * 60_000;
const HOSTED_RECONNECT_EVERY_MS = 5_000;

/**
 * Why a thread on a gateway profile lists no claude.ai connectors: Claude Code loads them only
 * when the claude.ai login is its auth, and the profile's `ANTHROPIC_API_KEY` takes precedence.
 */
export const GATEWAY_CLAUDE_AI_NOTE =
  "claude.ai connectors need your Claude sign-in; this thread uses a gateway key.";

/** What a connector says when claude.ai refused Claude Code's own sign-in, not the connector's. */
export const CLAUDE_SIGN_IN_AGAIN = `claude.ai turned down Claude Code's own sign-in, so signing in to the connector can't help. Sign in to Claude again: ${DEFAULT_SIGN_IN_HINT}`;

/** A field of an object the SDK's typings don't name, or `undefined`. */
const untyped = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;

const toTool = ({ name, annotations }: NonNullable<McpServerStatus["tools"]>[number]) => {
  const tool: ConnectorTool = {
    name,
    ...(annotations?.readOnly === undefined ? {} : { readOnly: annotations.readOnly }),
    ...(annotations?.destructive === undefined ? {} : { destructive: annotations.destructive }),
  };
  return tool;
};

/**
 * What a claude.ai connector's status says beyond its typings (0.3.292): its catalogue entry's
 * eligibility and managed sign-in ride on `config` as Claude Code fetched them, and the reason a
 * connection failed on the untyped `error_code`.
 */
const claudeAiOf = (server: McpServerStatus): ClaudeAiConnector | undefined => {
  const config: unknown = server.config;
  if (untyped(config, "type") !== "claudeai-proxy" && server.scope !== "claudeai") return undefined;
  const id = untyped(config, "id");
  const reason = untyped(config, "ineligibleReason");
  const details: ClaudeAiConnector = {
    ...(typeof id === "string" ? { id } : {}),
    ...(untyped(config, "eligible") === false
      ? {
          blocked:
            typeof reason === "string" && reason.trim() !== ""
              ? reason
              : "Your organisation's policy keeps it out.",
        }
      : {}),
    ...(untyped(config, "enterpriseManaged") === true ? { orgManaged: true } : {}),
    ...(untyped(server, "error_code") === CLAUDEAI_BEARER_REJECTED
      ? { claudeSignInRejected: true }
      : {}),
  };
  return Object.keys(details).length === 0 ? undefined : details;
};

/**
 * One server as `mcpServerStatus` reports it, without its descriptions or `_meta`: the address
 * (masked as Settings masks one), where it came from, its tools' names and hints, and for a
 * claude.ai connector what claude.ai says of it.
 */
export const toConnectorStatus = (server: McpServerStatus, canSignIn = false): ConnectorStatus => {
  const url = untyped(server.config, "url");
  const claudeAi = claudeAiOf(server);
  const signInUnavailable =
    claudeAi?.claudeSignInRejected === true
      ? CLAUDE_SIGN_IN_AGAIN
      : server.status === "needs-auth" && !canSignIn
        ? CLAUDE_SIGN_IN_HINT
        : undefined;
  return {
    name: server.name,
    status: server.status,
    ...(server.error === undefined ? {} : { error: server.error }),
    ...(server.scope === undefined ? {} : { scope: server.scope }),
    ...(server.source === undefined ? {} : { source: server.source }),
    ...(typeof url === "string" ? { url: presentableUrl(url) } : {}),
    ...(server.tools === undefined || server.name === APP_TOOL_SERVER
      ? {}
      : { tools: server.tools.map(toTool) }),
    ...(claudeAi === undefined ? {} : { claudeAi }),
    ...(signInUnavailable === undefined ? {} : { signInUnavailable }),
    ...(server.name === APP_TOOL_SERVER
      ? { builtIn: true, toggleUnavailable: BUILT_IN_TOGGLE_REASON }
      : {}),
  };
};

/** One server as a `system/init` (`mcp_servers`) or an `mcpServerStatus()` read lists it. */
export interface SeenServer {
  readonly name: string;
  readonly status: string;
  readonly source?: string | undefined;
  readonly scope?: string | undefined;
  /** Only a status read carries these, never an init. */
  readonly error?: string | undefined;
  readonly errorCode?: string | undefined;
}

/**
 * Claude Code's own claude.ai sign-in was refused, so every connector fails at once and signing in
 * to one of them fixes nothing.
 */
export const CLAUDEAI_BEARER_REJECTED = "CLAUDEAI_BEARER_REJECTED";

const isClaudeAi = (server: SeenServer) =>
  server.scope === "claudeai" ||
  server.source === "claudeai" ||
  server.name.startsWith("claude.ai ");

const needsSignIn = (server: SeenServer) =>
  server.errorCode !== CLAUDEAI_BEARER_REJECTED && awaitsSignIn(server);

/** Which claude.ai connectors a session has seen working, and which of them need a sign-in now. */
export interface LapsedConnectors {
  readonly worked: ReadonlySet<string>;
  readonly lapsed: ReadonlyArray<string>;
}

export const NO_LAPSED_CONNECTORS: LapsedConnectors = { worked: new Set(), lapsed: [] };

/**
 * `previous` after the session listed `servers`: a claude.ai connector lapsed when it is signed out
 * now and either connected earlier in the session or is one Claude Code remembers connecting
 * (`everConnected`). Listing order is kept, and a connector the listing leaves out is no longer
 * lapsed.
 */
export const nextLapsedConnectors = (
  previous: LapsedConnectors,
  servers: ReadonlyArray<SeenServer>,
  everConnected: ReadonlySet<string>,
): LapsedConnectors => {
  const hosted = servers.filter(isClaudeAi);
  const worked = new Set(previous.worked);
  for (const server of hosted) if (server.status === "connected") worked.add(server.name);
  const lapsed = hosted
    .filter((server) =>
      // A lapsed one reconnecting is still lapsed until it connects: a sign-in's reconnect.
      server.status === "pending"
        ? previous.lapsed.includes(server.name)
        : needsSignIn(server) && (worked.has(server.name) || everConnected.has(server.name)),
    )
    .map((server) => server.name);
  return { worked, lapsed };
};

/** A status read as `nextLapsedConnectors` takes it, with the `error_code` the SDK leaves untyped. */
export const seenServer = (server: McpServerStatus): SeenServer => {
  const code = (server as { readonly error_code?: unknown }).error_code;
  return {
    name: server.name,
    status: server.status,
    source: server.source,
    scope: server.scope,
    error: server.error,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
};

const STATES: ReadonlySet<string> = new Set<ConnectorStatus["status"]>([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]);

const isState = (status: string): status is ConnectorStatus["status"] => STATES.has(status);

/**
 * One server of a turn's `system/init`, which names it, its state and where it came from (`source`,
 * a scope such as `claudeai`), and nothing else. A state this build doesn't know is left out.
 */
export const initServer = ({ name, status, source }: SeenServer): ReadonlyArray<ConnectorStatus> =>
  isState(status) ? [{ name, status, ...(source === undefined ? {} : { scope: source }) }] : [];

const controlFailed = (error: unknown) =>
  new AgentUnavailable({
    agent: "claude",
    message: `Claude Code couldn't change its connectors: ${error instanceof Error ? error.message : String(error)}`,
  });

const signInFailed = (name: string) => (error: unknown) =>
  new AgentUnavailable({
    agent: "claude",
    message: `Claude Code couldn't start signing in to ${name}: ${error instanceof Error ? error.message : String(error)}`,
  });

/** The `mcpAuthenticate` of an SDK that has one at runtime, whatever its typings say. */
const authenticatorOf = (q: object): McpAuthenticator | undefined => {
  const method = (q as Partial<Record<keyof McpAuthenticator, unknown>>).mcpAuthenticate;
  return typeof method === "function"
    ? { mcpAuthenticate: (name) => Reflect.apply(method, q, [name]) as Promise<unknown> }
    : undefined;
};

/** How the session was opened, as far as its connectors care. */
export interface ConnectorsOptions {
  /** On a gateway profile, whose key keeps every claude.ai connector out. */
  readonly gateway?: boolean;
  /** Took none of the user's servers for want of tool search (`mcpNoneWithoutToolSearch`). */
  readonly noToolSearch?: boolean;
  /** Sees every status read's servers, so they count towards lapsed connectors too. */
  readonly observe?: ((servers: ReadonlyArray<McpServerStatus>) => void) | undefined;
}

/** The SDK's `mcpServerStatus` / `reconnectMcpServer` / `toggleMcpServer` / `mcpAuthenticate`. */
export const makeConnectors = (
  q: Pick<Query, "mcpServerStatus" | "reconnectMcpServer" | "toggleMcpServer">,
  policy: Pick<
    OpenSessionOptions,
    "confineWrites" | "mcpAllowlist" | "mcpDenylist" | "mcpNoneWithoutToolSearch" | "audience"
  > = {},
  options: ConnectorsOptions = {},
): AgentConnectors => {
  const reconnectFailed = (name: string) => (error: unknown) => {
    const failed = controlFailed(error);
    // Claude Code calls flag-settings restrictions "enterprise managed policy" too.
    if (!/blocked by enterprise managed policy|Server not found:/i.test(failed.message)) {
      return failed;
    }
    if (name === APP_TOOL_SERVER) return failed;
    if (policy.confineWrites === true) {
      return new AgentUnavailable({
        agent: "claude",
        message: `Gram excludes external connectors from this confined session; ${name} can't be reconnected here.`,
      });
    }
    // On its default connectors an orchestrator's allowlist, if it has one, is its workspace's.
    const orchestrator =
      policy.audience === "orchestrator" && policy.mcpNoneWithoutToolSearch !== true;
    // A changed workspace set reopens the session by itself once it is idle; the orchestrator
    // list in settings is read at the next open.
    const orchestratorFix =
      "Settings → Workspaces → Orchestrator connectors, and to the workspace's Connectors if they list only some (use the connector's upstream URL for claude.ai connectors), then restart the session.";
    const fix = orchestrator
      ? orchestratorFix
      : "the workspace's Connectors in Settings → Workspaces (use the connector's upstream URL for claude.ai connectors); the session picks the change up once it is idle.";
    const denylist = policy.mcpDenylist ?? [];
    if (denylist.includes(name)) {
      return new AgentUnavailable({
        agent: "claude",
        message: `This workspace's connectors leave out ${name}; take it off the workspace's Connectors in Settings → Workspaces, and the session picks the change up once it is idle.`,
      });
    }
    const allowlist = policy.mcpAllowlist;
    if (options.noToolSearch === true) {
      return new AgentUnavailable({
        agent: "claude",
        message: `An orchestrator without tool search, as on a gateway key, would load every connector's tool schemas up front, so it gets none of your connectors unless they are listed. To give it ${name}, add it to ${orchestratorFix}`,
      });
    }
    if (allowlist === undefined || allowlist.includes(name)) {
      // A missing hosted server's URL isn't in mcpServerStatus, so a URL entry may be what left it out.
      if (!denylist.some((entry) => entry.includes("://"))) return failed;
      return new AgentUnavailable({
        agent: "claude",
        message: `Check this workspace's connectors for ${name} in Settings → Workspaces. ${failed.message}`,
      });
    }
    const role = orchestrator ? "orchestrator" : "workspace";
    // A missing hosted server's URL isn't available in mcpServerStatus, so a URL grant may match.
    const uncertain = allowlist.some((entry) => entry.includes("://"));
    const reason = uncertain
      ? `Check Gram's ${role} connector allowlist for ${name}`
      : `Gram's ${role} connector allowlist doesn't include ${name}`;
    return new AgentUnavailable({
      agent: "claude",
      message: `${reason}; add it to ${fix}${uncertain ? ` ${failed.message}` : ""}`,
    });
  };
  const authenticator = authenticatorOf(q);
  /**
   * claude.ai connectors signing in, by name: when it began and when it was last retried. Claude
   * Code doesn't hear when the user finishes on claude.ai, so while the sign-in is being watched
   * the server is reconnected now and then until it connects.
   */
  const hosted = new Map<string, { readonly since: number; tried: number }>();
  const nudge = (servers: ReadonlyArray<McpServerStatus>, now: number) => {
    for (const [name, attempt] of hosted) {
      const server = servers.find((listed) => listed.name === name);
      const waiting = server !== undefined && awaitsSignIn(server);
      // `pending` is a retry still connecting, so it is neither the end nor a reason to retry.
      if (
        (!waiting && server?.status !== "pending") ||
        now - attempt.since > HOSTED_SIGN_IN_WAIT_MS
      ) {
        hosted.delete(name);
      } else if (waiting && now - attempt.tried >= HOSTED_RECONNECT_EVERY_MS) {
        attempt.tried = now;
        // Not awaited, so the listing isn't held up; a refusal only means "not yet".
        q.reconnectMcpServer(name).catch(() => undefined);
      }
    }
  };

  const authenticate = (
    signIn: McpAuthenticator,
    name: string,
  ): Effect.Effect<ConnectorSignInStart, AgentUnavailable> =>
    Effect.gen(function* () {
      if (name === APP_TOOL_SERVER) {
        return yield* new AgentUnavailable({
          agent: "claude",
          message: "Gram's app tools don't need a sign-in.",
        });
      }
      const answer = yield* Effect.tryPromise({
        try: () => signIn.mcpAuthenticate(name),
        catch: signInFailed(name),
      });
      // The decode error would quote the answer, and nothing says what else it carries.
      const response = yield* Schema.decodeUnknownEffect(AuthenticateResponse)(answer).pipe(
        Effect.mapError(() => signInFailed(name)("its answer wasn't a sign-in page")),
      );
      // Already signed in: Claude Code refreshed the token and reconnects the server itself.
      if (response.authUrl === undefined) return "started" as const;
      if (!webPage(response.authUrl)) {
        return yield* signInFailed(name)("its sign-in page isn't a web address");
      }
      if (response.callbackExpected === false) {
        const now = yield* Clock.currentTimeMillis;
        hosted.set(name, { since: now, tried: now });
      }
      return { authorizationUrl: response.authUrl };
    });

  return {
    status: Effect.tryPromise({
      try: () => q.mcpServerStatus(),
      catch: controlFailed,
    }).pipe(
      Effect.tap((servers) =>
        Clock.currentTimeMillis.pipe(Effect.map((now) => nudge(servers, now))),
      ),
      Effect.tap((servers) => Effect.sync(() => options.observe?.(servers))),
      Effect.map((servers) =>
        servers.map((server) => toConnectorStatus(server, authenticator !== undefined)),
      ),
    ),
    reconnect: (name) =>
      Effect.tryPromise({ try: () => q.reconnectMcpServer(name), catch: reconnectFailed(name) }),
    setEnabled: (name, enabled) =>
      name === APP_TOOL_SERVER
        ? Effect.fail(new AgentUnavailable({ agent: "claude", message: BUILT_IN_TOGGLE_REASON }))
        : Effect.tryPromise({
            try: () => q.toggleMcpServer(name, enabled),
            catch: controlFailed,
          }).pipe(Effect.as("applied" as const)),
    ...(authenticator === undefined
      ? {}
      : { authenticate: (name: string) => authenticate(authenticator, name) }),
    ...(options.gateway === true ? { claudeAiUnavailable: GATEWAY_CLAUDE_AI_NOTE } : {}),
  };
};

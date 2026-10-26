import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/** An MCP connector's state, as the agent's `mcpServerStatus` reports it. */
export const ConnectorState = Schema.Literals([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]);
export type ConnectorState = typeof ConnectorState.Type;

/** One tool a connected server offers, with the hints its MCP annotations give. */
export const ConnectorTool = Schema.Struct({
  name: Schema.String,
  /** The server says the tool changes nothing (`readOnlyHint`). */
  readOnly: Schema.optionalKey(Schema.Boolean),
  /** The server says the tool may delete or overwrite (`destructiveHint`). */
  destructive: Schema.optionalKey(Schema.Boolean),
});
export type ConnectorTool = typeof ConnectorTool.Type;

/**
 * What claude.ai says of one of its hosted connectors, beyond the status Claude Code gives every
 * server. Each field is absent when it doesn't say.
 */
export const ClaudeAiConnector = Schema.Struct({
  /** The connector's id in the account's claude.ai catalogue. */
  id: Schema.optionalKey(Schema.String),
  /** Kept out by the organisation's policy: claude.ai's reason (`ineligibleReason`), or a generic one. */
  blocked: Schema.optionalKey(Schema.String),
  /** Its sign-in is managed by the organisation (`enterpriseManaged`), not by the user. */
  orgManaged: Schema.optionalKey(Schema.Boolean),
  /**
   * claude.ai refused Claude Code's own sign-in (`CLAUDEAI_BEARER_REJECTED`): signing in to the
   * connector can't help, signing in to Claude again does.
   */
  claudeSignInRejected: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeAiConnector = typeof ClaudeAiConnector.Type;

export const Connector = Schema.Struct({
  name: Schema.String,
  status: ConnectorState,
  /** Where the connector is configured, e.g. `project`, `user` or `claudeai`. */
  scope: Schema.optionalKey(Schema.String),
  /** Where its definition came from, as Claude Code says (`source`): a scope, `plugin` or `sdk`. */
  source: Schema.optionalKey(Schema.String),
  /**
   * The server's address, with anything credential-shaped masked. A claude.ai connector's is its
   * upstream server's, which another agent can add and sign in to itself.
   */
  url: Schema.optionalKey(Schema.String),
  /** What it offers, once connected; absent when the agent doesn't say. */
  tools: Schema.optionalKey(Schema.Array(ConnectorTool)),
  /** For a claude.ai connector, what claude.ai says of it. */
  claudeAi: Schema.optionalKey(ClaudeAiConnector),
  error: Schema.optionalKey(Schema.String),
  /** Gram's own app-tools server for the thread; it stays on. */
  builtIn: Schema.optionalKey(Schema.Boolean),
  /** Why the agent can't reconnect this server live; absent when it can. */
  reconnectUnavailable: Schema.optionalKey(Schema.String),
  /** Why this server can't be switched on or off; absent when it can. */
  toggleUnavailable: Schema.optionalKey(Schema.String),
  /** How to sign in when `connectors.authenticate` can't start it for this agent; absent when it can. */
  signInUnavailable: Schema.optionalKey(Schema.String),
  /** What a toggle affects beyond this thread; absent when it only affects this thread. */
  toggleNote: Schema.optionalKey(Schema.String),
  /**
   * In the agent's config, but the session hasn't reported it yet: it is still loading its servers.
   * Shown as "Checking…", never as missing.
   */
  unconfirmed: Schema.optionalKey(Schema.Boolean),
  /** Left out of this session on purpose, by its workspace's connectors or the orchestrator list. */
  notGiven: Schema.optionalKey(Schema.Boolean),
});
export type Connector = typeof Connector.Type;

/**
 * How a connector stands, in the words every view shares, from the thread's own connection, so
 * Settings and the panel never disagree.
 */
export type ConnectorHealth =
  | "connected"
  | "connecting"
  | "failed"
  | "disabled"
  | "needs-auth"
  | "not-given";

export const connectorHealth = (
  connector: Pick<Connector, "status" | "unconfirmed" | "notGiven">,
): ConnectorHealth => {
  if (connector.notGiven === true) return "not-given";
  if (connector.status === "disabled") return "disabled";
  if (connector.status === "connected") return "connected";
  if (connector.status === "pending" || connector.unconfirmed === true) return "connecting";
  if (connector.status === "needs-auth") return "needs-auth";
  return "failed";
};

/** What a `failed` connector's error says when its sign-in is what was refused. */
const SIGN_IN_REFUSED =
  /\b401\b|unauthori[sz]ed|authenticat|token (?:has )?expired|sign(?:ed)?[ -]?in/i;

/**
 * Whether the connector waits on a sign-in: signed out, or failed because its sign-in was refused.
 * A sign-in under way lasts while this holds, as it does while the connector is still connecting.
 */
export const awaitsSignIn = (connector: {
  readonly status: string;
  readonly error?: string | undefined;
}): boolean =>
  connector.status === "needs-auth" ||
  (connector.status === "failed" &&
    connector.error !== undefined &&
    SIGN_IN_REFUSED.test(connector.error));

/** What each health reads as, the same in a thread's panel and in Settings. */
export const CONNECTOR_HEALTH_LABEL: Readonly<Record<ConnectorHealth, string>> = {
  connected: "Connected",
  connecting: "Checking…",
  failed: "Failed",
  disabled: "Disabled",
  "needs-auth": "Not signed in",
  "not-given": "Not given to this thread",
};

/** How `connectors.setEnabled` took effect: live, or by reopening the session once it's idle. */
export const ConnectorToggleResult = Schema.Struct({
  session: Schema.Literals(["applied", "reopening", "noSession"]),
});
export type ConnectorToggleResult = typeof ConnectorToggleResult.Type;

/**
 * `connectors.authenticate`: the agent's own OAuth sign-in has started. `open` carries the page to
 * open in the browser; `started` means the agent opened it itself. Either way the agent receives the
 * callback and keeps the token, and the connector's status changes once it has. `onClaudeAi`, from
 * `connectors.signIn` with no Claude thread to watch it: claude.ai's page for a connector, which
 * tells nobody when the user finishes, so the connector shows as signed in only once a Claude
 * thread reports it.
 */
export const ConnectorSignIn = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("open"), authorizationUrl: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("started") }),
  Schema.Struct({ kind: Schema.Literal("onClaudeAi"), authorizationUrl: Schema.String }),
]);
export type ConnectorSignIn = typeof ConnectorSignIn.Type;

/**
 * `connectors.list`: the live session's connectors, or why there's nothing to show. Listing never
 * starts a session: `noSession` means the thread has to be started first, `unsupported` that its
 * agent doesn't report connectors.
 */
export const ConnectorList = Schema.Union([
  Schema.Struct({
    live: Schema.Literal(true),
    connectors: Schema.Array(Connector),
    /** Why the session loads none of the account's claude.ai connectors; absent when it may. */
    claudeAiUnavailable: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    live: Schema.Literal(false),
    reason: Schema.Literals(["noSession", "unsupported"]),
  }),
]);
export type ConnectorList = typeof ConnectorList.Type;

/** One connector of one thread's session. */
export const ConnectorRef = { threadId: ThreadId, name: Schema.String };

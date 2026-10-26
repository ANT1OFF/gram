import * as Schema from "effect/Schema";
import { ClaudeAiConnector, ConnectorState, ConnectorTool } from "./connectors.ts";
import { ThreadId } from "./ids.ts";

/**
 * Where Claude Code keeps an MCP server (`claude mcp add-json --scope`): `local` for you in this
 * project, `project` in the repo's `.mcp.json`, `user` for you in every project.
 */
export const McpScope = Schema.Literals(["local", "project", "user"]);
export type McpScope = typeof McpScope.Type;

/**
 * The agents whose own MCP config Gram can write. Each keeps its servers, and the OAuth
 * tokens for them, itself; Gram stores neither.
 */
export const McpTarget = Schema.Literals(["claude", "codex"]);
export type McpTarget = typeof McpTarget.Type;

/** What the user calls each agent. */
export const MCP_TARGET_LABEL: Readonly<Record<McpTarget, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** `agent` as a config target; `undefined` for an agent whose MCP config Gram can't write. */
export const mcpTargetOf = (agent: string | undefined): McpTarget | undefined =>
  agent === "claude" || agent === "codex" ? agent : undefined;

/** The scopes each agent really has: Codex keeps every server in its one `config.toml`. */
export const MCP_TARGET_SCOPES: Readonly<Record<McpTarget, ReadonlyArray<McpScope>>> = {
  claude: ["local", "project", "user"],
  codex: ["user"],
};

/** Where `target` keeps a server asked for at `scope`: that scope when it has it, else `user`. */
export const mcpScopeFor = (target: McpTarget, scope: McpScope): McpScope =>
  MCP_TARGET_SCOPES[target].includes(scope) ? scope : "user";

/** Server names accepted by `claude mcp`. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const McpServerName = Schema.String.check(Schema.isPattern(MCP_SERVER_NAME_PATTERN));

const StringMap = Schema.Record(Schema.String, Schema.String);
const HttpUrl = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/));

/** One server entry, as Claude Code's `mcpServers` holds it. Env and header values are secrets. */
export const McpServerConfig = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stdio"),
    command: Schema.String.check(Schema.isMinLength(1)),
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(StringMap),
  }),
  Schema.Struct({
    type: Schema.Literal("http"),
    url: HttpUrl,
    headers: Schema.optionalKey(StringMap),
  }),
  Schema.Struct({
    type: Schema.Literal("sse"),
    url: HttpUrl,
    headers: Schema.optionalKey(StringMap),
  }),
]);
export type McpServerConfig = typeof McpServerConfig.Type;

/** `connectors.add`: a server for a thread's checkout (its live session reopens), or a folder. */
export const AddConnectorPayload = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  /** The project folder, when there's no thread. */
  cwd: Schema.optionalKey(Schema.String),
  /** Claude Code's scope; every other target gets `mcpScopeFor` of it. */
  scope: McpScope,
  name: McpServerName,
  config: McpServerConfig,
  /** The agents to write it for. Absent: the thread's own agent, or Claude Code for a folder. */
  targets: Schema.optionalKey(Schema.NonEmptyArray(McpTarget)),
});
export type AddConnectorPayload = typeof AddConnectorPayload.Type;

/** `connectors.remove`: without `scope`, from whichever scope has the server. */
export const RemoveConnectorPayload = Schema.Struct({
  threadId: Schema.optionalKey(ThreadId),
  cwd: Schema.optionalKey(Schema.String),
  name: McpServerName,
  scope: Schema.optionalKey(McpScope),
  /** The agent whose config holds it. Absent: the thread's own agent, or Claude Code for a folder. */
  target: Schema.optionalKey(McpTarget),
});
export type RemoveConnectorPayload = typeof RemoveConnectorPayload.Type;

/**
 * What changed for the thread: `applied` when its live session loaded the new config in place,
 * `reopening` when it reopens once idle to load it, `noSession` when nothing was open (the next
 * session loads it).
 */
export const ConnectorConfigResult = Schema.Struct({
  name: Schema.String,
  session: Schema.Literals(["applied", "reopening", "noSession"]),
});
export type ConnectorConfigResult = typeof ConnectorConfigResult.Type;

/** `connectors.configured`: what each agent's own config holds, read fresh and never kept. */
export const ConfiguredConnectorsPayload = Schema.Struct({
  /** A project folder, to include the servers an agent keeps per project. Absent: user-wide only. */
  cwd: Schema.optionalKey(Schema.String),
  /**
   * Agents to ask for sign-in state although answering makes them start and connect every server
   * they have (`signIn: "onRequest"`). Never sent without the user asking.
   */
  checkSignIn: Schema.optionalKey(Schema.Array(McpTarget)),
  /**
   * Read the agents' configs now rather than answer with the last read: the
   * user asked to refresh. Absent: the last read comes back at once, and a newer one starts behind
   * it when it is more than a few seconds old.
   */
  fresh: Schema.optionalKey(Schema.Boolean),
});
export type ConfiguredConnectorsPayload = typeof ConfiguredConnectorsPayload.Type;

/**
 * One server as an agent's config holds it. Header and env values never leave the server process:
 * `carriesValues` says only that there are some, so a copy made from this would be missing them.
 */
export const ConfiguredServer = Schema.Struct({
  name: Schema.String,
  /** `other` for a transport only that agent speaks (Claude Code's `ws`, say). */
  transport: Schema.Literals(["stdio", "http", "sse", "other"]),
  url: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  /** One of the agent's `MCP_TARGET_SCOPES`, or where else it came from (`claudeai`, `plugin`). */
  scope: Schema.String,
  /** Absent when the agent doesn't say, or the server has no sign-in. */
  signedIn: Schema.optionalKey(Schema.Boolean),
  carriesValues: Schema.Boolean,
  /** Switched off in the agent's config. */
  disabled: Schema.optionalKey(Schema.Boolean),
  /** Why the last sign-in Gram started for it, with no thread to run it in, didn't finish. */
  signInFailed: Schema.optionalKey(Schema.String),
  /**
   * When a Claude thread last reported this claude.ai connector, as an ISO time, for a row that
   * comes from that report because no Claude thread that has it is running: its state is as of
   * then. Absent on a row a running thread or a config file gives.
   */
  seenAt: Schema.optionalKey(Schema.String),
  /** Claude Code has connected this claude.ai connector before (`claudeAiMcpEverConnected`). */
  everConnected: Schema.optionalKey(Schema.Boolean),
  /** A claude.ai connector's tools, as a Claude thread reports them. */
  tools: Schema.optionalKey(Schema.Array(ConnectorTool)),
  /** For a claude.ai connector, what claude.ai says of it, as `Connector.claudeAi`. */
  claudeAi: Schema.optionalKey(ClaudeAiConnector),
});
export type ConfiguredServer = typeof ConfiguredServer.Type;

/**
 * A claude.ai connector as a Claude thread last reported it, kept by the server so Settings can show
 * the account's connectors with no Claude thread running: Claude Code can't list them without
 * connecting every one. Only what a thread said, and nothing secret.
 */
export const SeenConnector = Schema.Struct({
  name: Schema.String,
  status: ConnectorState,
  /** When a thread last reported it, in epoch milliseconds. */
  seenAt: Schema.Number,
  /** Its upstream address, masked, as `Connector.url`; kept from an earlier report when the last didn't say. */
  url: Schema.optionalKey(Schema.String),
  /** Its id in the account's claude.ai catalogue (`ClaudeAiConnector.id`). */
  id: Schema.optionalKey(Schema.String),
  /** Its tools when it was last seen connected. */
  tools: Schema.optionalKey(Schema.Array(ConnectorTool)),
});
export type SeenConnector = typeof SeenConnector.Type;

/**
 * How much an agent says about sign-ins without a thread: `reported` in `signedIn`, `onRequest`
 * only through `checkSignIn`, `liveOnly` only while one of its threads is running.
 */
export const SignInKnowledge = Schema.Literals(["reported", "onRequest", "liveOnly"]);
export type SignInKnowledge = typeof SignInKnowledge.Type;

/** `AgentConfiguredServers.claudeAiFrom`. */
export const ClaudeAiSource = Schema.Literals(["thread", "lastSeen", "history"]);
export type ClaudeAiSource = typeof ClaudeAiSource.Type;

export const AgentConfiguredServers = Schema.Struct({
  target: McpTarget,
  servers: Schema.Array(ConfiguredServer),
  signIn: SignInKnowledge,
  /** False when a sign-in can only start while one of this agent's threads is running. */
  threadlessSignIn: Schema.optionalKey(Schema.Boolean),
  /** Why this agent's config couldn't be read; the other agents' lists still stand. */
  error: Schema.optionalKey(Schema.String),
  /**
   * Where Claude Code's claude.ai connectors come from: a running Claude thread (`thread`), the
   * last report of one (`lastSeen`, with `seenAt` on each), or, before any report, the ones it has
   * connected before (`history`). Absent for the other agents, and when none are listed.
   */
  claudeAiFrom: Schema.optionalKey(ClaudeAiSource),
  /** Why no claude.ai connector is listed although Claude threads are running, as `ConnectorList`'s. */
  claudeAiUnavailable: Schema.optionalKey(Schema.String),
});
export type AgentConfiguredServers = typeof AgentConfiguredServers.Type;

export const ConfiguredConnectors = Schema.Struct({
  agents: Schema.Array(AgentConfiguredServers),
  /**
   * This answer is the last read, and a newer one is running behind it: asked again shortly, the
   * server answers with that one once it lands.
   */
  refreshing: Schema.optionalKey(Schema.Boolean),
});
export type ConfiguredConnectors = typeof ConfiguredConnectors.Type;

/**
 * `connectors.signIn`: an agent's own OAuth sign-in for one of its servers, from Settings rather
 * than a thread. Claude Code's goes through a running Claude thread that has the server, else
 * `claude mcp login`.
 */
export const ConnectorSignInPayload = Schema.Struct({
  target: McpTarget,
  /**
   * The name the agent lists the server by, not one Gram would write: a claude.ai
   * connector's is its display name, such as `claude.ai Teams`.
   */
  name: Schema.NonEmptyString,
  /**
   * The project folder, for an agent whose servers run per folder: Claude Code, whose per-project
   * servers sign in through a thread in that folder.
   */
  cwd: Schema.optionalKey(Schema.String),
  /**
   * The scope of the row signed in from. A Claude session lists one server per name, and a
   * `local` or `project` one shadows the user's, so this picks the session whose server it is.
   */
  scope: Schema.optionalKey(Schema.String),
});
export type ConnectorSignInPayload = typeof ConnectorSignInPayload.Type;

/** Where EXAMPLE's MCP platform serves its servers, each at `https://<host>/<id>`. */
export const EXAMPLE_MCP_HOST = "mcp.example.invalid";

/** Who may sign in to a platform server, as its Entra app's role assignments say. */
export const CatalogueAccess = Schema.Struct({
  /** Assigned to every EXAMPLE user. */
  everyone: Schema.Boolean,
  /** The Entra groups assigned, by name, such as `SYS_(MCP)_(registry)`. */
  groups: Schema.Array(Schema.String),
});
export type CatalogueAccess = typeof CatalogueAccess.Type;

/** One server the platform offers, as its own repositories describe it. */
export const CatalogueServer = Schema.Struct({
  /** Its path under the platform's host, and the name it is added by. */
  id: McpServerName,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  url: HttpUrl,
  /** Absent when the server's Entra app couldn't be read. */
  access: Schema.optionalKey(CatalogueAccess),
  /**
   * The agents whose sign-in its Entra app doesn't accept yet, for want of their redirect address.
   * Absent when the app couldn't be read.
   */
  signInUnsupported: Schema.optionalKey(Schema.Array(McpTarget)),
});
export type CatalogueServer = typeof CatalogueServer.Type;

/** `connectors.catalogue`: every server the platform offers, read when asked and never kept. */
export const ConnectorCatalogue = Schema.Struct({
  servers: Schema.Array(CatalogueServer),
  /** What the list was read from, to say so. */
  source: Schema.String,
  /** Why access and sign-in support couldn't be read; the list stands without them. */
  detailsError: Schema.optionalKey(Schema.String),
});
export type ConnectorCatalogue = typeof ConnectorCatalogue.Type;

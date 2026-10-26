import {
  effectiveCheckout,
  InvalidState,
  mcpScopeFor,
  mcpTargetOf,
  type AddConnectorPayload,
  type ConfiguredConnectors,
  type ConfiguredConnectorsPayload,
  type CatalogueServer,
  type ConfiguredServer,
  type ConnectorCatalogue,
  type Connector,
  type ConnectorConfigResult,
  type ConnectorList,
  type ConnectorSignIn,
  type ConnectorSignInPayload,
  type ConnectorToggleResult,
  type McpTarget,
  type RemoveConnectorPayload,
  type ThreadId,
} from "@gram/contracts";

import type { MockWorld } from "../mock-world";
import type { ConnectorsApi } from "./types";

// MCP connector fixtures for MockApi: one connector per status, kept per thread so actions stick.

/** Synthetic personal document service, connected through claude.ai with four invented tools. */
const HOSTED_DOCS = {
  name: "claude.ai Personal Docs",
  url: "https://mcp.example.invalid/personal-docs",
  tools: [
    { name: "search", readOnly: true },
    { name: "get_document", readOnly: true },
    { name: "delete_bookmark", readOnly: false, destructive: true },
    { name: "add_bookmark" },
  ],
} as const satisfies Pick<Connector, "name" | "url" | "tools">;

const SEED: readonly Connector[] = [
  {
    name: "gram",
    status: "connected",
    builtIn: true,
    toggleUnavailable: "Gram's app tools stay on for every thread.",
  },
  { name: "github", status: "connected", scope: "user" },
  { name: "linear", status: "needs-auth", scope: "claudeai" },
  {
    name: HOSTED_DOCS.name,
    status: "connected",
    scope: "claudeai",
    source: "claudeai",
    url: HOSTED_DOCS.url,
    tools: HOSTED_DOCS.tools,
    claudeAi: { id: "mcpsrv_personal_docs" },
  },
  {
    name: "sentry",
    status: "failed",
    scope: "project",
    error: "connect ECONNREFUSED 127.0.0.1:8931",
  },
  { name: "playwright", status: "pending", scope: "project" },
  { name: "notion", status: "disabled", scope: "user" },
];

const remote = (name: string, scope: string, signedIn?: boolean): ConfiguredServer => ({
  name,
  transport: "http",
  url: `https://personal.example.invalid/${name}`,
  scope,
  carriesValues: false,
  ...(signedIn === undefined ? {} : { signedIn }),
});

const CONFIGURED: Readonly<Record<McpTarget, ReadonlyArray<ConfiguredServer>>> = {
  claude: [
    remote("github", "user", true),
    // As a Claude thread last reported it: no Claude thread runs in the mock's Settings.
    {
      name: "linear",
      transport: "other",
      scope: "claudeai",
      carriesValues: false,
      signedIn: false,
      seenAt: "2026-10-08T12:00:00.000Z",
      everConnected: true,
    },
    {
      name: "files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      scope: "local",
      carriesValues: true,
    },
    remote("example", "user"),
    remote("registry", "user"),
    {
      name: HOSTED_DOCS.name,
      transport: "other",
      url: HOSTED_DOCS.url,
      scope: "claudeai",
      carriesValues: false,
      signedIn: true,
      tools: HOSTED_DOCS.tools,
      claudeAi: { id: "mcpsrv_personal_docs" },
    },
  ],
  codex: [remote("github", "user", true), remote("example", "user", false)],
};

/** A synthetic catalogue; ordinary Settings never requests one. */
const OPTIONAL_CATALOGUE: ReadonlyArray<CatalogueServer> = [
  {
    id: "personal-docs",
    title: "Personal Docs",
    description: "Invented document service for protocol tests",
    url: "https://docs.example.invalid/mcp",
    access: { everyone: true, groups: [] },
    signInUnsupported: [],
  },
];

/** A mutable connector set per thread. Threads without a session (`cold`) report none. */
export class MockConnectors {
  readonly #byThread = new Map<string, Connector[]>();
  readonly #configured: Record<McpTarget, ConfiguredServer[]> = {
    claude: [...CONFIGURED.claude],
    codex: [...CONFIGURED.codex],
  };

  configured(input: ConfiguredConnectorsPayload): ConfiguredConnectors {
    const of = (target: McpTarget) =>
      this.#configured[target]
        .filter(
          (server) =>
            input.cwd !== undefined || server.scope === "user" || server.scope === "claudeai",
        )
        .map(({ signedIn, ...server }) =>
          signedIn === undefined || (target === "codex" && !input.checkSignIn?.includes("codex"))
            ? server
            : { ...server, signedIn },
        );
    return {
      agents: [
        {
          target: "claude",
          signIn: "liveOnly",
          threadlessSignIn: true,
          claudeAiFrom: "lastSeen",
          servers: of("claude"),
        },
        { target: "codex", signIn: "onRequest", servers: of("codex") },
      ],
    };
  }

  /**
   * Like each agent with no thread: the sign-in lands in the agent's own store a moment later.
   * Claude Code's goes through `claude mcp login`, which opens the browser itself, except for a
   * claude.ai connector: that page is claude.ai's, and nothing hears when it's done.
   */
  signIn(input: ConnectorSignInPayload, signedIn: () => void): ConnectorSignIn {
    if (input.scope === "claudeai") {
      return {
        kind: "onClaudeAi",
        authorizationUrl: `https://claude.ai/api/organizations/o/mcp/start-auth/${input.name}`,
      };
    }
    setTimeout(() => {
      this.#configured[input.target] = this.#configured[input.target].map((server) =>
        server.name === input.name ? { ...server, signedIn: true } : server,
      );
      signedIn();
    }, MockConnectors.SIGN_IN_MS);
    return input.target === "codex"
      ? { kind: "open", authorizationUrl: `https://idp.example/authorize?server=${input.name}` }
      : { kind: "started" };
  }

  catalogue(): ConnectorCatalogue {
    return { source: "synthetic/personal-services", servers: OPTIONAL_CATALOGUE };
  }

  /** A server added or removed with no thread changes the agents' configs and nothing else. */
  #configure(input: AddConnectorPayload | RemoveConnectorPayload) {
    const targets: ReadonlyArray<McpTarget> =
      "config" in input ? (input.targets ?? ["claude"]) : [input.target ?? "claude"];
    for (const target of targets) {
      const others = this.#configured[target].filter((server) => server.name !== input.name);
      if ("config" in input) {
        if (others.length !== this.#configured[target].length) {
          throw new InvalidState({
            message: `Couldn't add ${input.name}: MCP server ${input.name} already exists`,
          });
        }
        const { config } = input;
        others.push({
          name: input.name,
          scope: mcpScopeFor(target, input.scope),
          ...(config.type === "stdio"
            ? {
                transport: "stdio",
                command: config.command,
                ...(config.args === undefined ? {} : { args: config.args }),
                carriesValues: config.env !== undefined,
              }
            : {
                transport: config.type,
                url: config.url,
                carriesValues: config.headers !== undefined,
                ...(config.headers === undefined ? { signedIn: false } : {}),
              }),
        });
      }
      this.#configured[target] = others;
    }
  }

  list(threadId: ThreadId, cold: boolean): ConnectorList {
    return cold
      ? { live: false, reason: "noSession" }
      : { live: true, connectors: [...this.#of(threadId)] };
  }

  /** A failed or pending connector connects; one that needs sign-in still needs it. */
  reconnect(threadId: ThreadId, cold: boolean, name: string) {
    this.#update(threadId, cold, name, (c) =>
      c.status === "failed" || c.status === "pending"
        ? { name: c.name, status: "connected", ...scope(c) }
        : c,
    );
  }

  setEnabled(
    threadId: ThreadId,
    cold: boolean,
    name: string,
    enabled: boolean,
  ): ConnectorToggleResult {
    const connector = this.#of(threadId).find((c) => c.name === name);
    if (connector?.toggleUnavailable !== undefined) {
      throw new InvalidState({ message: connector.toggleUnavailable, threadId });
    }
    this.#update(threadId, cold, name, (c) =>
      enabled
        ? c.status === "disabled"
          ? { name: c.name, status: "connected", ...scope(c) }
          : c
        : { name: c.name, status: "disabled", ...scope(c) },
    );
    return { session: "applied" };
  }

  /** How long the pretend user spends in the browser before the agent has its token. */
  static readonly SIGN_IN_MS = 400;

  /** Like Codex: hands back the page to open, and the connector connects a moment later. */
  authenticate(threadId: ThreadId, cold: boolean, name: string): ConnectorSignIn {
    const connector = this.#of(threadId).find((c) => c.name === name);
    if (connector?.signInUnavailable !== undefined) {
      throw new InvalidState({ message: connector.signInUnavailable, threadId });
    }
    this.#update(threadId, cold, name, (c) => c);
    setTimeout(() => {
      this.#update(threadId, false, name, (c) => ({
        name: c.name,
        status: "connected",
        ...scope(c),
      }));
    }, MockConnectors.SIGN_IN_MS);
    return { kind: "open", authorizationUrl: `https://idp.example/authorize?server=${name}` };
  }

  /** A claude.ai connector that was connected and now needs its sign-in again. */
  lapse(threadId: ThreadId, name: string) {
    const connectors = this.#of(threadId).filter((c) => c.name !== name);
    this.#byThread.set(threadId, [
      ...connectors,
      { name, status: "needs-auth", scope: "claudeai" },
    ]);
  }

  /** Like `claude mcp add-json`: a taken name is refused; a live session lists the new server. */
  add(input: AddConnectorPayload, cold: boolean): ConnectorConfigResult {
    if (input.threadId === undefined) this.#configure(input);
    else {
      const connectors = this.#of(input.threadId);
      if (connectors.some((c) => c.name === input.name)) {
        throw new InvalidState({
          message: `Couldn't add ${input.name}: MCP server ${input.name} already exists`,
        });
      }
      this.#byThread.set(input.threadId, [
        ...connectors,
        // A remote server with no credentials of its own comes up asking for its OAuth sign-in.
        {
          name: input.name,
          status:
            input.config.type !== "stdio" && input.config.headers === undefined
              ? "needs-auth"
              : "connected",
          scope: input.scope,
        },
      ]);
    }
    return { name: input.name, session: cold ? "noSession" : "reopening" };
  }

  remove(input: RemoveConnectorPayload, cold: boolean): ConnectorConfigResult {
    if (input.threadId === undefined) this.#configure(input);
    else {
      const connectors = this.#of(input.threadId);
      if (!connectors.some((c) => c.name === input.name)) {
        throw new InvalidState({
          message: `Couldn't remove ${input.name}: No MCP server found with name: ${input.name}`,
        });
      }
      this.#byThread.set(
        input.threadId,
        connectors.filter((c) => c.name !== input.name),
      );
    }
    return { name: input.name, session: cold ? "noSession" : "reopening" };
  }

  #of(threadId: ThreadId): Connector[] {
    let connectors = this.#byThread.get(threadId);
    if (!connectors) {
      connectors = SEED.map((c) => ({ ...c }));
      this.#byThread.set(threadId, connectors);
    }
    return connectors;
  }

  #update(threadId: ThreadId, cold: boolean, name: string, f: (c: Connector) => Connector) {
    if (cold)
      throw new InvalidState({ message: "Start the thread to change its connectors.", threadId });
    const connectors = this.#of(threadId);
    this.#byThread.set(
      threadId,
      connectors.map((c) => (c.name === name ? f(c) : c)),
    );
  }
}

const scope = (c: Connector) => (c.scope === undefined ? {} : { scope: c.scope });

/** What the e2e specs read back through `window.gramMock`. */
export interface ConnectorsMockControls {
  /** What the app asked to add, config and targets included, so tests can check the payload. */
  readonly connectorAdds: AddConnectorPayload[];
  /** Each `listConfiguredConnectors` call, so tests can check nothing asked Codex to connect. */
  readonly configuredConnectorReads: ConfiguredConnectorsPayload[];
  /** Each catalogue read, so tests can check opening the page didn't read it. */
  readonly catalogueReads: ConnectorCatalogue[];
  /**
   * Has the thread's claude.ai connector `name` lapse, as Claude Code's next `system/init` would
   * report it; a listing that finds it connected again clears it, as a status read does.
   */
  lapseConnector(threadId: ThreadId, name: string): void;
}

/** `ConnectorsApi` over `MockConnectors`, with what it was asked recorded for the specs. */
export function createConnectorsMock(world: MockWorld): ConnectorsApi & ConnectorsMockControls {
  const connectors = new MockConnectors();
  /** Cold threads have no session, so there are no connectors to report or change. */
  const cold = (threadId: ThreadId) => world.summary(threadId).status === "cold";
  const connectorAdds: AddConnectorPayload[] = [];
  const configuredConnectorReads: ConfiguredConnectorsPayload[] = [];
  const catalogueReads: ConnectorCatalogue[] = [];
  /** Like the server's `changeOf`: a per-project scope reaches the folder's threads only. */
  const changed = async (
    input: AddConnectorPayload | RemoveConnectorPayload,
    targets: ReadonlyArray<McpTarget>,
  ) => {
    const folder =
      input.threadId === undefined
        ? input.cwd
        : effectiveCheckout(world.summary(input.threadId).thread).path;
    for (const target of targets) {
      // Claude Code's reconnect loads an added server in place; only a removal restarts.
      if (target === "claude" && "config" in input) continue;
      const perFolder = input.scope !== undefined && mcpScopeFor(target, input.scope) !== "user";
      await world.mcpConfigChanged(target, perFolder ? folder : undefined);
    }
  };
  /** The agent a request without targets is for: the thread's own, as the server's `placeFor`. */
  const agentOf = (threadId: ThreadId | undefined): McpTarget =>
    (threadId === undefined
      ? undefined
      : mcpTargetOf(world.summary(threadId).thread.model.agent)) ?? "claude";
  const lapsedOf = (threadId: ThreadId) => world.summary(threadId).lapsedConnectors ?? [];
  return {
    connectorAdds,
    configuredConnectorReads,
    catalogueReads,
    lapseConnector: (threadId, name) => {
      connectors.lapse(threadId, name);
      world.publishLapsedConnectors(threadId, [
        ...lapsedOf(threadId).filter((n) => n !== name),
        name,
      ]);
    },
    listConnectors: async (threadId) => {
      // Like the server: a session still opening has nothing to report yet.
      const list = connectors.list(
        threadId,
        cold(threadId) || world.summary(threadId).status === "starting",
      );
      const was = lapsedOf(threadId);
      if (list.live && was.length > 0) {
        const still = was.filter(
          (name) => list.connectors.find((c) => c.name === name)?.status === "needs-auth",
        );
        if (still.length !== was.length) world.publishLapsedConnectors(threadId, still);
      }
      return list;
    },
    reconnectConnector: async (threadId, name) => {
      connectors.reconnect(threadId, cold(threadId), name);
    },
    setConnectorEnabled: async (threadId, name, enabled) =>
      connectors.setEnabled(threadId, cold(threadId), name, enabled),
    authenticateConnector: async (threadId, name) => {
      await world.delay(10);
      return connectors.authenticate(threadId, cold(threadId), name);
    },
    addConnector: async (input) => {
      await world.delay(10);
      connectorAdds.push(input);
      const result = connectors.add(input, input.threadId === undefined || cold(input.threadId));
      const targets = input.targets ?? [agentOf(input.threadId)];
      await changed(input, targets);
      const inPlace =
        result.session === "reopening" &&
        agentOf(input.threadId) === "claude" &&
        targets.includes("claude");
      return inPlace ? { ...result, session: "applied" } : result;
    },
    removeConnector: async (input) => {
      await world.delay(10);
      const result = connectors.remove(input, input.threadId === undefined || cold(input.threadId));
      await changed(input, [input.target ?? agentOf(input.threadId)]);
      return result;
    },
    listConfiguredConnectors: async (input) => {
      await world.delay(10);
      configuredConnectorReads.push(input);
      return connectors.configured(input);
    },
    signInConnector: async (input) => {
      await world.delay(10);
      // Claude Code's sessions waiting on the server reconnect; the other agents' restart.
      return connectors.signIn(input, () => {
        if (input.target !== "claude") void world.mcpConfigChanged(input.target, undefined);
      });
    },
    listConnectorCatalogue: async () => {
      await world.delay(10);
      const catalogue = connectors.catalogue();
      catalogueReads.push(catalogue);
      return catalogue;
    },
  };
}

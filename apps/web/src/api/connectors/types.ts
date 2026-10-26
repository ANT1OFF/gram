import type {
  AddConnectorPayload,
  ConfiguredConnectors,
  ConfiguredConnectorsPayload,
  ConnectorCatalogue,
  ConnectorConfigResult,
  ConnectorList,
  ConnectorSignIn,
  ConnectorSignInPayload,
  ConnectorToggleResult,
  RemoveConnectorPayload,
  ThreadId,
} from "@gram/contracts";

/** `connectors.*`: a thread's live MCP connectors, and each agent's configured servers. */
export interface ConnectorsApi {
  /** The thread's MCP connectors; `live: false` when there's no session to ask. Never starts one. */
  listConnectors(threadId: ThreadId): Promise<ConnectorList>;
  /** Rejects with `InvalidState` while the thread has no live session. */
  reconnectConnector(threadId: ThreadId, name: string): Promise<void>;
  /** Applied live, or by reopening the session once it's idle when the agent can't toggle live. */
  setConnectorEnabled(
    threadId: ThreadId,
    name: string,
    enabled: boolean,
  ): Promise<ConnectorToggleResult>;
  /**
   * Starts the agent's own OAuth sign-in for a connector. `open` carries the page for the app to
   * open; with `started` the agent opened it. The list shows the outcome once the agent has it.
   */
  authenticateConnector(threadId: ThreadId, name: string): Promise<ConnectorSignIn>;
  /** Adds an MCP server through Claude Code's CLI; a live session reopens once idle to connect it. */
  addConnector(input: AddConnectorPayload): Promise<ConnectorConfigResult>;
  /** Removes an MCP server; without `scope`, from whichever scope has it. */
  removeConnector(input: RemoveConnectorPayload): Promise<ConnectorConfigResult>;
  /**
   * Every agent's configured MCP servers, read fresh from the agents' own configs with no thread and
   * no connection made. Header and env values never come; `checkSignIn` is only for a user who asked.
   */
  listConfiguredConnectors(input: ConfiguredConnectorsPayload): Promise<ConfiguredConnectors>;
  /** `authenticateConnector` from Settings; Claude Code needs a Claude thread running for it. */
  signInConnector(input: ConnectorSignInPayload): Promise<ConnectorSignIn>;
  /** EXAMPLE's MCP platform's servers, read from GitHub when asked; no server is contacted. */
  listConnectorCatalogue(): Promise<ConnectorCatalogue>;
}

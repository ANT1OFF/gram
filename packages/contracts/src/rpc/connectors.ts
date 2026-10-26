import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import {
  ConnectorRef,
  ConnectorList,
  ConnectorSignIn,
  ConnectorToggleResult,
} from "../connectors.ts";
import { AgentUnavailable, InvalidState, ThreadNotFound } from "../errors.ts";
import { errors, threadRef } from "./shared.ts";
import {
  AddConnectorPayload,
  ConfiguredConnectors,
  ConfiguredConnectorsPayload,
  ConnectorCatalogue,
  ConnectorConfigResult,
  ConnectorSignInPayload,
  RemoveConnectorPayload,
} from "../connectors-config.ts";

/** MCP connectors: a thread's live agent session's, and each agent's configured ones. */
export const ConnectorRpcs = RpcGroup.make(
  Rpc.make("connectors.list", {
    payload: threadRef,
    success: ConnectorList,
    error: errors(ThreadNotFound, AgentUnavailable),
  }),
  Rpc.make("connectors.reconnect", {
    payload: ConnectorRef,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  /** Live when the agent can; otherwise the session reopens once idle to apply it. */
  Rpc.make("connectors.setEnabled", {
    payload: { ...ConnectorRef, enabled: Schema.Boolean },
    success: ConnectorToggleResult,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  /** Starts the agent's own OAuth sign-in for a connector; Gram never sees the token. */
  Rpc.make("connectors.authenticate", {
    payload: ConnectorRef,
    success: ConnectorSignIn,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  /** Writes each target agent's own MCP config; secrets in env or headers never come back. */
  Rpc.make("connectors.add", {
    payload: AddConnectorPayload,
    success: ConnectorConfigResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  Rpc.make("connectors.remove", {
    payload: RemoveConnectorPayload,
    success: ConnectorConfigResult,
    error: errors(ThreadNotFound, InvalidState),
  }),
  /** Settings → Connectors: every agent's configured servers, without a thread or a connection. */
  Rpc.make("connectors.configured", {
    payload: ConfiguredConnectorsPayload,
    success: ConfiguredConnectors,
    error: errors(),
  }),
  /**
   * EXAMPLE's MCP platform's servers, read from its repositories on GitHub through `gh`. Only when the
   * user asks: it reaches GitHub, and never any of the servers.
   */
  Rpc.make("connectors.catalogue", {
    success: ConnectorCatalogue,
    error: errors(InvalidState),
  }),
  /** `connectors.authenticate` with no thread; Claude Code's runs in a live Claude thread. */
  Rpc.make("connectors.signIn", {
    payload: ConnectorSignInPayload,
    success: ConnectorSignIn,
    error: errors(InvalidState, AgentUnavailable),
  }),
);

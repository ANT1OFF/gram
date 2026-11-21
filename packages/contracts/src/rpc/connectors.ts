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
  Rpc.make("connectors.setEnabled", {
    payload: { ...ConnectorRef, enabled: Schema.Boolean },
    success: ConnectorToggleResult,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
  Rpc.make("connectors.authenticate", {
    payload: ConnectorRef,
    success: ConnectorSignIn,
    error: errors(ThreadNotFound, InvalidState, AgentUnavailable),
  }),
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
  Rpc.make("connectors.configured", {
    payload: ConfiguredConnectorsPayload,
    success: ConfiguredConnectors,
    error: errors(),
  }),
  Rpc.make("connectors.catalogue", {
    success: ConnectorCatalogue,
    error: errors(InvalidState),
  }),
  Rpc.make("connectors.signIn", {
    payload: ConnectorSignInPayload,
    success: ConnectorSignIn,
    error: errors(InvalidState, AgentUnavailable),
  }),
);

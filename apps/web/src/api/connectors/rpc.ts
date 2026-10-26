import { run, type RpcContext } from "../rpc-client";
import type { ConnectorsApi } from "./types";

/** `ConnectorsApi` over the RPC client. */
export const connectorsRpc = ({ client }: RpcContext): ConnectorsApi => ({
  listConnectors: (threadId) => run(client["connectors.list"]({ threadId })),
  reconnectConnector: (threadId, name) => run(client["connectors.reconnect"]({ threadId, name })),
  setConnectorEnabled: (threadId, name, enabled) =>
    run(client["connectors.setEnabled"]({ threadId, name, enabled })),
  authenticateConnector: (threadId, name) =>
    run(client["connectors.authenticate"]({ threadId, name })),
  addConnector: (input) => run(client["connectors.add"](input)),
  removeConnector: (input) => run(client["connectors.remove"](input)),
  listConfiguredConnectors: (input) => run(client["connectors.configured"](input)),
  signInConnector: (input) => run(client["connectors.signIn"](input)),
  listConnectorCatalogue: () => run(client["connectors.catalogue"](undefined)),
});

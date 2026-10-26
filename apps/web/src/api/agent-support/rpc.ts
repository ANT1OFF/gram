import { run, type RpcContext } from "../rpc-client";
import type { AgentSupportApi } from "./types";

export const agentSupportRpc = ({ client }: RpcContext): AgentSupportApi => ({
  agentSupport: (model, options) => run(client["agents.support"]({ model, ...options })),
});

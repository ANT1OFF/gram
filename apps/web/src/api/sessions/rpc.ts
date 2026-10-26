import { run, type RpcContext } from "../rpc-client";
import type { SessionsApi } from "./types";

/** `SessionsApi` over the RPC client. */
export const sessionsRpc = ({ client }: RpcContext): SessionsApi => ({
  listSessions: (agent, projectRoot, limit) =>
    run(
      client["sessions.list"](
        limit === undefined ? { agent, projectRoot } : { agent, projectRoot, limit },
      ),
    ),
  deleteSession: (agent, projectRoot, agentSessionId) =>
    run(client["sessions.delete"]({ agent, projectRoot, agentSessionId })),
  previewSession: (agent, projectRoot, agentSessionId) =>
    run(client["sessions.preview"]({ agent, projectRoot, agentSessionId })),
});

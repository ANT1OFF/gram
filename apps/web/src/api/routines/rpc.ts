import { run, type RpcContext } from "../rpc-client";
import type { RoutinesApi } from "./types";

/** `RoutinesApi` over the RPC client. */
export const routinesRpc = ({ client }: RpcContext): RoutinesApi => ({
  listRoutines: (workspaceId) => run(client["routine.list"]({ workspaceId })),
  runRoutine: (workspaceId, id) => run(client["routine.run"]({ workspaceId, id })),
});

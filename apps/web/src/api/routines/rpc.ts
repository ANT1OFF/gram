import { run, type RpcContext } from "../rpc-client";
import type { RoutinesApi } from "./types";

/** `RoutinesApi` over the RPC client. */
export const routinesRpc = ({ client }: RpcContext): RoutinesApi => ({
  listRoutines: (workspaceId) => run(client["routine.list"]({ workspaceId })),
  createRoutine: (workspaceId, draft) => run(client["routine.create"]({ workspaceId, draft })),
  updateRoutine: (id, patch) => run(client["routine.update"]({ id, patch })),
  removeRoutine: (id) => run(client["routine.remove"]({ id })),
  runRoutine: (id) => run(client["routine.run"]({ id })),
});

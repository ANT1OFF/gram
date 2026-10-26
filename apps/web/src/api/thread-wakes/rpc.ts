import { run, type RpcContext } from "../rpc-client";
import type { ThreadWakesApi } from "./types";

/** `ThreadWakesApi` over the RPC client. */
export const threadWakesRpc = ({ client }: RpcContext): ThreadWakesApi => ({
  listThreadWakes: () => run(client["threads.wakes"](undefined)),
  cancelThreadWake: (threadId, id) =>
    run(client["thread.cancelWake"](id === undefined ? { threadId } : { threadId, id })),
});

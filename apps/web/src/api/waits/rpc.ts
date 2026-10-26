import { run, type RpcContext } from "../rpc-client";
import type { WaitsApi } from "./types";

/** `WaitsApi` over the RPC client. */
export const waitsRpc = ({ client }: RpcContext): WaitsApi => ({
  resolveWait: (threadId, id, undo) =>
    run(client["thread.resolveWait"]({ threadId, id, ...(undo === true ? { undo } : {}) })),
  keepWait: (threadId, id) => run(client["thread.keepWait"]({ threadId, id })),
  addWait: (threadId, messageId, options = {}) =>
    run(
      client["thread.addWait"]({
        threadId,
        messageId,
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    ),
  listWaits: (threadId, state) =>
    run(client["thread.listWaits"]({ threadId, ...(state === undefined ? {} : { state }) })),
});

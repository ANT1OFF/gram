import { run, type RpcContext } from "../rpc-client";
import type { PagesApi } from "./types";

/** `PagesApi` over the RPC client. */
export const pagesRpc = ({ client }: RpcContext): PagesApi => ({
  listPages: (workspaceId) => run(client["pages.list"]({ workspaceId })),
  pinPage: (threadId, path) => run(client["pages.pin"]({ threadId, path })),
  openPage: (workspaceId, id) => run(client["pages.open"]({ workspaceId, id })),
  showPageOffer: (workspaceId, id, version) =>
    run(client["pages.showOffer"]({ workspaceId, id, version })),
  unpinPage: (workspaceId, id) => run(client["pages.unpin"]({ workspaceId, id })),
});

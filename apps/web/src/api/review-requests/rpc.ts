import { run, type RpcContext } from "../rpc-client";
import type { ReviewRequestsApi } from "./types";

/** `ReviewRequestsApi` over the RPC client. */
export const reviewRequestsRpc = ({ client }: RpcContext): ReviewRequestsApi => ({
  listReviewRequests: () => run(client["reviewRequests.list"](undefined)),
  refreshReviewRequests: (options) =>
    run(client["reviewRequests.refresh"](options?.force === true ? { force: true } : {})),
  listOpenPrs: () => run(client["openPrs.list"](undefined)),
});

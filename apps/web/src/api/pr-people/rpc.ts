import { run, type RpcContext } from "../rpc-client";
import type { PrPeopleApi } from "./types";

/** `PrPeopleApi` over the RPC client. */
export const prPeopleRpc = ({ client }: RpcContext): PrPeopleApi => ({
  prRequestReview: (threadId, reviewers) =>
    run(client["pr.requestReview"]({ threadId, reviewers })),
  prReviewerSuggestions: (threadId) => run(client["pr.reviewerSuggestions"]({ threadId })),
  prLabelsList: (threadId) => run(client["pr.labels.list"]({ threadId })),
  prLabelsAdd: (threadId, labels) => run(client["pr.labels.add"]({ threadId, labels })),
  prLabelsRemove: (threadId, labels) => run(client["pr.labels.remove"]({ threadId, labels })),
});

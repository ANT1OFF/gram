import { run, type RpcContext } from "../rpc-client";
import type { PullRequestsApi } from "./types";

/** `PullRequestsApi` over the RPC client. */
export const pullRequestsRpc = ({ client }: RpcContext): PullRequestsApi => ({
  gitDiff: (threadId, diffScope) => run(client["git.diff"]({ threadId, scope: diffScope })),
  prDetail: (threadId) => run(client["git.prDetail"]({ threadId })),
  prCheckDiagnostic: (threadId, selection) =>
    run(client["git.prCheckDiagnostic"]({ threadId, selection })),
  prChecks: (threadId) => run(client["git.prChecks"]({ threadId })),
  prRerunChecks: (threadId) => run(client["git.prRerunChecks"]({ threadId })),
  prMergeOptions: (threadId) => run(client["pr.mergeOptions"]({ threadId })),
  prMerge: (threadId, strategy, auto) =>
    run(client["pr.merge"]({ threadId, strategy, ...(auto === undefined ? {} : { auto }) })),
  prReady: (threadId, draft) => run(client["pr.ready"]({ threadId, draft })),
  prClose: (threadId) => run(client["pr.close"]({ threadId })),
  prReopen: (threadId) => run(client["pr.reopen"]({ threadId })),
  prUpdateBranch: (threadId) => run(client["pr.updateBranch"]({ threadId })),
  refreshGit: (threadId) => run(client["git.refresh"]({ threadId })),
  pushBranch: (threadId) => run(client["git.push"]({ threadId })),
  prDraft: (threadId, base) => run(client["pr.draft"]({ threadId, base })),
  prCreate: (input) => run(client["pr.create"](input)),
  prBind: (threadId, repo, number, monitor) =>
    run(
      client["pr.bind"](
        monitor === undefined ? { threadId, repo, number } : { threadId, repo, number, monitor },
      ),
    ),
  prUnbind: (threadId) => run(client["pr.unbind"]({ threadId })),
  prSetMonitor: (threadId, monitor) => run(client["pr.setMonitor"]({ threadId, monitor })),
  prBindExtra: (threadId, repo, number, monitor) =>
    run(
      client["pr.bindExtra"](
        monitor === undefined ? { threadId, repo, number } : { threadId, repo, number, monitor },
      ),
    ),
  prUnbindExtra: (threadId, repo, number) =>
    run(client["pr.unbindExtra"]({ threadId, repo, number })),
  prSetExtraMonitor: (threadId, repo, number, monitor) =>
    run(client["pr.setExtraMonitor"]({ threadId, repo, number, monitor })),
  prPromote: (threadId, repo, number) => run(client["pr.promote"]({ threadId, repo, number })),
  prHide: (threadId, pr) => run(client["pr.hide"]({ threadId, pr })),
  prShowHidden: (threadId) => run(client["pr.showHidden"]({ threadId })),
  prReview: (threadId) => run(client["git.prReview"]({ threadId })),
  prApplySuggestion: (threadId, commentId) =>
    run(client["git.prApplySuggestion"]({ threadId, commentId })),
  prReplyThread: (threadId, reviewThreadId, body) =>
    run(client["git.prReplyThread"]({ threadId, reviewThreadId, body })),
  prResolveThread: (threadId, reviewThreadId) =>
    run(client["git.prResolveThread"]({ threadId, reviewThreadId })),
  prRequestRereview: (threadId) => run(client["git.prRequestRereview"]({ threadId })),
});

import { run, type RpcContext } from "../rpc-client";
import type { BranchesApi } from "./types";

/** `BranchesApi` over the RPC client. */
export const branchesRpc = ({ client }: RpcContext): BranchesApi => ({
  branches: (repoPath) => run(client["git.branches"]({ repoPath })),
  baseStatus: (repoPath, base) => run(client["git.baseStatus"]({ repoPath, base })),
  fetchBase: (repoPath, base) => run(client["git.fetchBase"]({ repoPath, base })),
  upstreamStatus: (repoPath) => run(client["git.upstreamStatus"]({ repoPath })),
  upstreamSync: (repoPath) => run(client["git.upstreamSync"]({ repoPath })),
  fastForward: (repoPath) => run(client["git.fastForward"]({ repoPath })),
});

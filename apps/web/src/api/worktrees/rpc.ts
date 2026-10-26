import { run, type RpcContext } from "../rpc-client";
import type { WorktreesApi } from "./types";

/** `WorktreesApi` over the RPC client. */
export const worktreesRpc = ({ client }: RpcContext): WorktreesApi => ({
  listWorktrees: (repoPath) => run(client["worktree.list"]({ repoPath })),
  worktreeStatus: (path) => run(client["worktree.status"]({ path })),
  worktreePendingPermissions: (path) => run(client["worktree.pendingPermissionsAt"]({ path })),
  worktreeSize: (path) => run(client["worktree.size"]({ path })),
  removeWorktree: (path, options) => run(client["worktree.remove"]({ path, ...options })),
  storageReport: () => run(client["worktree.storage"]({})),
  cleanupPlan: (inactiveDays) => run(client["worktree.cleanupPlan"]({ inactiveDays })),
  cleanUpWorktrees: (paths, options = {}) =>
    run(
      client["worktree.cleanUp"]({
        paths,
        ...(options.confirmed === undefined ? {} : { confirmed: options.confirmed }),
        ...(options.prune === undefined ? {} : { prune: options.prune }),
      }),
    ),
});

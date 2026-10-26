import type { MockWorld } from "../mock-world";
import type { BranchesApi } from "./types";

/** Three hours, how long ago the mock repo reads as fetched until a fetch. */
const STALE_MS = 3 * 60 * 60 * 1000;

/** `BranchesApi` over one mock repo: a fetch brings two commits that a fast-forward then takes. */
export function createBranchesMock(world: MockWorld): BranchesApi {
  /** Epoch ms of the last mock fetch. */
  let fetchedAt: number | undefined;
  /** Commits `origin/main` has that the mock checkout doesn't, until a fast-forward. */
  let behind = 0;
  return {
    branches: async () => ({ branches: ["main", "develop", "release/1.8"], default: "main" }),
    baseStatus: async (_repoPath, base) => ({
      ref: base,
      fetchedAt: fetchedAt ?? Date.now() - STALE_MS,
    }),
    fetchBase: async (_repoPath, base) => {
      await world.delay(300);
      fetchedAt = Date.now();
      behind = 2;
      return { ref: base, fetchedAt, newCommits: 2 };
    },
    upstreamStatus: async () => ({
      branch: "main",
      ref: "origin/main",
      fetchedAt: fetchedAt ?? Date.now() - STALE_MS,
    }),
    upstreamSync: async () => ({
      branch: "main",
      ref: "origin/main",
      ahead: 0,
      behind,
      changedFiles: 0,
      ...(behind === 0 ? { blocker: "it's up to date" } : {}),
    }),
    fastForward: async () => {
      await world.delay(200);
      const commits = behind;
      behind = 0;
      return { branch: "main", ref: "origin/main", commits, head: "4f2a9c1" };
    },
  };
}

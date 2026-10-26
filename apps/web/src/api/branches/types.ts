import type {
  BaseRefStatus,
  BranchList,
  FastForwardResult,
  FetchBaseResult,
  UpstreamRefStatus,
  UpstreamSync,
} from "@gram/contracts";

/** A repo's branches: its base's last fetch, and its checkout against its upstream. */
export interface BranchesApi {
  branches(repoPath: string): Promise<BranchList>;
  /** When `base` (an `origin/` branch) was last fetched; local data only. */
  baseStatus(repoPath: string, base: string): Promise<BaseRefStatus>;
  /** Fetches `base` from origin and reports the commits that arrived. Only ever on a click. */
  fetchBase(repoPath: string, base: string): Promise<FetchBaseResult>;
  /** The current checkout's branch and its `origin/` upstream when it has one; local data only. */
  upstreamStatus(repoPath: string): Promise<UpstreamRefStatus>;
  /** The current branch against its upstream: ahead / behind, and why it can't fast-forward. Local only. */
  upstreamSync(repoPath: string): Promise<UpstreamSync>;
  /** Fast-forwards the current branch onto its upstream; refuses a dirty or diverged checkout. Only ever on a click. */
  fastForward(repoPath: string): Promise<FastForwardResult>;
}

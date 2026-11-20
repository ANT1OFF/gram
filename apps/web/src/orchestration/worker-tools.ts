import type { BoundPr, FinishedWorkerDetail, GitState, VerifyState } from "@gram/contracts";
import {
  FileDiff,
  FolderTree,
  GitPullRequest,
  MessageSquare,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import { worktreeMissing } from "@/components/worktree-missing";
import { prTargetOf } from "@/panels/pr-identity";
import { passedCount } from "@/panels/proof-panel";

import type { BesideTab } from "./beside-store";

// A worker's own tools in the pane's row, and why each that is off is off: from its git state, its
// PR and its repository's verify recipe, or from its record once only that is kept.

export interface Tool {
  readonly id: BesideTab;
  readonly label: string;
  readonly icon: LucideIcon;
  /** A count or number after its name: "3", "#142". */
  readonly count?: string | undefined;
  /** Why it can't be used now; it is off while this is set. */
  readonly off?: string | undefined;
}

/** Why Terminal and Files are off for a worker kept only as its record. */
export const WORKTREE_GONE = "Worktree cleaned up";
/** Why PR is off for a worker without one. */
export const NO_PR_YET = "No pull request yet";
/** Why Changes and PR are off for a worker that works in no repository. */
export const NO_REPOSITORY = "Not in a git repository";
/** Why Changes, Terminal and Files are off for a worker whose folder was deleted outside Gram. */
export const FOLDER_MISSING = "Its folder was deleted";
/** Why Terminal and Files are off for a finished worker whose worktree is still there. */
export const FINISHED = "Finished: read only";

/** What a worker's tools are offered by: where it works, its PR, and whether it is finished. */
export interface ToolFacts {
  readonly git: Pick<GitState, "repo" | "changedFiles" | "pr" | "missing" | "origin"> | undefined;
  /**
   * The PR the thread is bound to, which the PR tool opens: before its badge has loaded, and over
   * a badge that still names another PR.
   */
  readonly boundPr?: Pick<BoundPr, "repo" | "number"> | undefined;
  /** Finished (Done): read only, though its worktree may still be there. */
  readonly finished?: boolean;
  /** A finished worker's changed files as its PR lists them, once read. */
  readonly prFiles?: number | undefined;
  /** Its repository's verify recipe and Gram's record on its head, once read. */
  readonly verify?: VerifyState | undefined;
}

/** "3/4": the drivers that cover the change and passed on the head, of those that cover it. */
const proofCount = (verify: VerifyState): string | undefined => {
  if (verify.recipe !== "ok") return undefined;
  const { passed, of } = passedCount(verify);
  return of === 0 ? undefined : `${passed}/${of}`;
};

/**
 * The tools of a worker with a thread, from its git state: PR only with a PR to open, Changes,
 * Terminal and Files only with a checkout to read them from, and a finished one's Terminal and
 * Files off. One that is off says why.
 */
export const liveTools = ({
  git,
  boundPr,
  finished = false,
  prFiles,
  verify,
}: ToolFacts): readonly Tool[] => {
  const outside = git !== undefined && !git.repo;
  const missing = worktreeMissing(git as GitState | undefined);
  // The one its PR panel opens, its row's chip names and its head line shows.
  const pr = prTargetOf(git, boundPr)?.number;
  const changed = finished && prFiles !== undefined ? prFiles : (git?.changedFiles ?? 0);
  const noCheckout = missing ? FOLDER_MISSING : finished ? FINISHED : undefined;
  return [
    { id: "thread", label: "Conversation", icon: MessageSquare },
    {
      id: "changes",
      label: "Changes",
      icon: FileDiff,
      count: changed > 0 ? String(changed) : undefined,
      // A finished one's from its PR, which needs no checkout.
      off: outside
        ? NO_REPOSITORY
        : missing && !(finished && prFiles !== undefined)
          ? FOLDER_MISSING
          : undefined,
    },
    {
      id: "pr",
      label: "PR",
      icon: GitPullRequest,
      count: pr === undefined ? undefined : `#${pr}`,
      off: outside ? NO_REPOSITORY : pr === undefined ? NO_PR_YET : undefined,
    },
    // Only where the repository names checks: a repository without a recipe opted into none.
    ...(verify === undefined || verify.recipe === "none" || outside
      ? []
      : [{ id: "proof" as const, label: "Proof", icon: ShieldCheck, count: proofCount(verify) }]),
    { id: "terminal", label: "Terminal", icon: SquareTerminal, off: noCheckout },
    { id: "files", label: "Files", icon: FolderTree, off: noCheckout },
  ];
};

/**
 * The tools of a worker kept only as its record: its Changes from the same record its summary
 * counts, so the two never disagree, its PR while it had one, and no Terminal or Files.
 */
export const recordTools = (detail: FinishedWorkerDetail | undefined): readonly Tool[] => {
  const pr = detail?.worker.prs[0];
  return [
    { id: "thread", label: "Conversation", icon: MessageSquare },
    {
      id: "changes",
      label: "Changes",
      icon: FileDiff,
      count:
        detail === undefined || detail.files.length === 0 ? undefined : String(detail.files.length),
    },
    {
      id: "pr",
      label: "PR",
      icon: GitPullRequest,
      count: pr === undefined ? undefined : `#${pr.number}`,
      off: pr === undefined ? NO_PR_YET : undefined,
    },
    { id: "terminal", label: "Terminal", icon: SquareTerminal, off: WORKTREE_GONE },
    { id: "files", label: "Files", icon: FolderTree, off: WORKTREE_GONE },
  ];
};

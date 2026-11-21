import {
  checksOf,
  type OrchestratorLedger,
  type WorkerLedgerEntry,
  type WorkerPr,
} from "@gram/contracts";

/** A repo of the workspace's that nothing tests before a merge. */
export interface NoCiRepo {
  /** `owner/name`, as its PRs name it. */
  readonly repo: string;
  /** The project it is checked out as. */
  readonly project: string;
}

interface RepoFacts {
  readonly repo: string;
  readonly project: string;
  none: boolean;
  other: boolean;
  gated: boolean;
}

const prsByProject = (
  worker: WorkerLedgerEntry,
): ReadonlyArray<{
  readonly pr: WorkerPr;
  readonly project: string;
  readonly gateOff: boolean;
}> => [
  ...[worker.pr, ...(worker.morePrs ?? [])].flatMap((pr) =>
    pr === undefined
      ? []
      : [{ pr, project: worker.project, gateOff: worker.localGate !== undefined }],
  ),
  ...(worker.alsoIn ?? []).flatMap((repo) =>
    [repo.pr, ...(repo.morePrs ?? [])].flatMap((pr) =>
      pr === undefined
        ? []
        : [{ pr, project: repo.project, gateOff: repo.localGate !== undefined }],
    ),
  ),
];

/**
 * The repos of `ledger` with no CI: every open PR its live workers have there reports no hosted
 * checks, and its project has no local check. A repo with a PR whose checks run, pass, fail or
 * aren't looked up yet has CI, or may; an archived worker's PRs no longer refresh, so they say
 * nothing. Sorted by repo.
 */
export const noCiRepos = (ledger: Pick<OrchestratorLedger, "features"> | undefined): NoCiRepo[] => {
  const repos = new Map<string, RepoFacts>();
  for (const feature of ledger?.features ?? []) {
    for (const worker of feature.workers) {
      if (worker.state === "archived") continue;
      for (const { pr, project, gateOff } of prsByProject(worker)) {
        if (pr.state !== undefined && pr.state !== "open") continue;
        const key = pr.repo.toLowerCase();
        const facts = repos.get(key) ?? {
          repo: pr.repo,
          project,
          none: false,
          other: false,
          gated: false,
        };
        if (checksOf(pr.checks) === "none") facts.none = true;
        else facts.other = true;
        if (!gateOff) facts.gated = true;
        repos.set(key, facts);
      }
    }
  }
  return [...repos.values()]
    .filter((facts) => facts.none && !facts.other && !facts.gated)
    .map(({ repo, project }) => ({ repo, project }))
    .toSorted((a, b) => a.repo.localeCompare(b.repo));
};

/** The note's words: which repos, and why nothing tests their pull requests. */
export const noCiText = (repos: readonly NoCiRepo[]): string => {
  const names = repos.map((each) => each.repo);
  const list =
    names.length <= 2
      ? names.join(" and ")
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  const one = names.length === 1;
  return `No CI on ${list}: ${one ? "its" : "their"} pull requests report no hosted checks and no local check is set, so nothing tests them before they merge.`;
};

import type { RunWatch } from "@gram/contracts";

// The run chip's words and where its click goes, from the runs a worker watches: no React, so it is
// tested without a browser. See `overview-run-chip.tsx`.

/** A run a worker watches, as its wait carries it (`WaitReason.run`). */
export type WatchedRun = Pick<RunWatch, "repo" | "runId" | "name" | "url">;

export interface RunChip {
  /** How many runs it stands for: a count on the chip past one. */
  readonly count: number;
  /** Its accessible name, in one line. */
  readonly label: string;
  /** Its hover: a line per run, its name, where and that it runs. */
  readonly hint: string;
  /** What a click opens: the run on GitHub, or for several, their repo's runs. */
  readonly url: string;
}

/** A run's page: the one the watch read, else GitHub's for its id. */
const runUrl = (run: WatchedRun): string =>
  run.url ?? `https://github.com/${run.repo}/actions/runs/${run.runId}`;

/** "Application checks: fix the parser (acme/web #4411)": a run's name and where it runs. */
const runName = (run: WatchedRun): string =>
  `${run.name ?? "Workflow run"} (${run.repo} #${run.runId})`;

/** The chip for `runs`; none for no runs. */
export const runChipOf = (runs: readonly WatchedRun[]): RunChip | undefined => {
  const [first] = runs;
  if (first === undefined) return undefined;
  if (runs.length === 1) {
    return {
      count: 1,
      label: `Watching a workflow run: ${runName(first)}, running`,
      hint: `Watching a workflow run · running\n${runName(first)}`,
      url: runUrl(first),
    };
  }
  const repos = new Set(runs.map((run) => run.repo));
  const [repo] = repos;
  return {
    count: runs.length,
    label: `Watching ${runs.length} workflow runs: ${runs.map(runName).join("; ")}, all running`,
    hint: [`Watching ${runs.length} workflow runs · running`, ...runs.map(runName)].join("\n"),
    // One repo's runs open its Actions page, where they all are; runs in several, the first's.
    url: repos.size === 1 ? `https://github.com/${repo}/actions` : runUrl(first),
  };
};

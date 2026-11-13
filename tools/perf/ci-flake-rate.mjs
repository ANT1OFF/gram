#!/usr/bin/env node
// How often the trunk's checks go red: node tools/perf/ci-flake-rate.mjs <runs.json> [--branch main]
//
// The file is GitHub's listing of a workflow's runs, for example
//   gh api "repos/<owner>/<repo>/actions/workflows/check.yml/runs?branch=main&per_page=100" > runs.json
// Every commit on the trunk passed the same checks on its pull request, so a red run there is a
// test that fails some of the time, or two pull requests that only broke together. Cancelled runs
// were superseded by the next push and are left out. A run that passed on a later attempt counts
// as red: someone had to press the button.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function flakeRate(runs, branch = "main") {
  const counted = runs.filter(
    (run) =>
      run.head_branch === branch &&
      run.event === "push" &&
      run.status === "completed" &&
      (run.conclusion === "success" || run.conclusion === "failure"),
  );
  const red = counted.filter((run) => run.conclusion === "failure" || run.run_attempt > 1);
  const times = counted.map((run) => run.created_at).toSorted();
  return {
    runs: counted.length,
    red: red.length,
    rate: counted.length === 0 ? 0 : red.length / counted.length,
    from: times[0],
    to: times.at(-1),
    redRuns: red.map((run) => ({
      id: run.id,
      at: run.created_at,
      attempt: run.run_attempt,
      title: run.display_title,
    })),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("Usage: node tools/perf/ci-flake-rate.mjs <runs.json> [--branch main]");
    process.exit(2);
  }
  const at = rest.indexOf("--branch");
  const listing = JSON.parse(readFileSync(file, "utf8"));
  const result = flakeRate(listing.workflow_runs ?? listing, at === -1 ? "main" : rest[at + 1]);
  console.log(
    `${result.red} of ${result.runs} runs red (${(result.rate * 100).toFixed(0)}%), ${result.from} to ${result.to}`,
  );
  for (const run of result.redRuns)
    console.log(`  ${run.at}  attempt ${run.attempt}  ${run.id}  ${run.title}`);
}

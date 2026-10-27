import { qualifiedCiResults } from "../packages/git/src/ci-policy.ts";

/** Each job `qualification` needs, by its lane; `classify` is checked on its own. */
const JOB_LANES = {
  docs: "docs",
  "check-static": "static",
  "check-tests": "tests",
  "macos-tests": "tests",
  "macos-package": "package",
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((shard) => [`e2e-${shard}`, "e2e"])),
};

const needs = JSON.parse(process.env.CI_NEEDS ?? "{}");
let lanes;
try {
  lanes = JSON.parse(needs.classify?.outputs?.lanes ?? "");
} catch {
  lanes = undefined;
}
const jobs = Object.entries(needs)
  .filter(([id]) => id !== "classify")
  // A job missing from this table has no lane, so it can never qualify.
  .map(([id, job]) => ({ lane: JOB_LANES[id] ?? `unknown job ${id}`, result: job?.result }));
if (
  !Array.isArray(lanes) ||
  Object.keys(JOB_LANES).some((id) => !(id in needs)) ||
  !qualifiedCiResults(needs.classify?.outputs?.kind ?? "", lanes, needs.classify?.result, jobs)
)
  throw new Error("CI classification or required qualification jobs did not succeed");
console.log(`Qualified: ${needs.classify.outputs.kind} (${lanes.join(", ") || "docs"})`);

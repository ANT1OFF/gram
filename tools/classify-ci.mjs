// No install or new dependency is needed for classification on pinned Node 26.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import {
  CI_LANES,
  ciDiffArgs,
  ciLanes,
  DOCUMENTATION_POLICY,
} from "../packages/git/src/ci-policy.ts";

// Main pushes, manual runs and anything this can't classify run every lane.
let selected = new Set(CI_LANES);
let kind = "code";
const { CI_EVENT, CI_BASE, CI_HEAD, CI_MERGE, GITHUB_OUTPUT } = process.env;
const git = (args) =>
  execFileSync("git", ["--no-replace-objects", ...args], { encoding: "utf8" }).trim();
if (
  CI_EVENT === "pull_request" &&
  [CI_BASE, CI_HEAD, CI_MERGE].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))
) {
  try {
    // Classify from the event's merge of exactly base and head, as the workflow's jobs run: a
    // checkout of the branch alone would run its own classifier against another workflow.
    if (
      git(["rev-parse", "HEAD"]) !== CI_MERGE ||
      git(["show", "-s", "--format=%P", "HEAD"]) !== `${CI_BASE} ${CI_HEAD}`
    )
      throw new Error("Classification checkout isn't the event's merge of base and head");
    const policy = JSON.parse(
      execFileSync("git", ["--no-replace-objects", "show", `${CI_BASE}:.gram/merge-ci.json`], {
        encoding: "utf8",
      }),
    );
    if (policy.documentationPolicy === DOCUMENTATION_POLICY) {
      const lanes = ciLanes(
        execFileSync("git", ciDiffArgs(CI_BASE, CI_HEAD), {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        }),
      );
      if (lanes === "docs") {
        kind = "docs";
        selected = new Set();
      } else selected = new Set(lanes);
    }
  } catch {
    // Missing objects/policy, command errors and output limits never authorize skipping tests.
    kind = "code";
    selected = new Set(CI_LANES);
  }
}
const lanes = CI_LANES.filter((lane) => selected.has(lane));
console.log(`CI qualification: ${kind}${kind === "docs" ? "" : ` (${lanes.join(", ")})`}`);
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `kind=${kind}\nlanes=${JSON.stringify(lanes)}\n`);

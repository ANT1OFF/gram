// No install or new dependency is needed for classification on pinned Node 26.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { ciDiffArgs, classifyCiDiff, DOCUMENTATION_POLICY } from "../packages/git/src/ci-policy.ts";

let kind = "full";
const { CI_EVENT, CI_BASE, CI_HEAD, GITHUB_OUTPUT } = process.env;
if (
  CI_EVENT === "pull_request" &&
  /^[a-f0-9]{40}$/.test(CI_BASE ?? "") &&
  /^[a-f0-9]{40}$/.test(CI_HEAD ?? "")
) {
  try {
    const policy = JSON.parse(
      execFileSync("git", ["--no-replace-objects", "show", `${CI_BASE}:.gram/merge-ci.json`], {
        encoding: "utf8",
      }),
    );
    if (policy.documentationPolicy === DOCUMENTATION_POLICY) {
      kind = classifyCiDiff(
        execFileSync("git", ciDiffArgs(CI_BASE, CI_HEAD), {
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        }),
      );
    }
  } catch {
    // Missing objects/policy, command errors and output limits never authorize skipping tests.
    kind = "full";
  }
}
console.log(`CI qualification: ${kind}`);
if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `kind=${kind}\n`);

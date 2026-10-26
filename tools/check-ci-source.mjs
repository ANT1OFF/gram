// Before docs checks, establish the exact event merge checkout and both immutable parents.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const { CI_BASE, CI_HEAD, CI_MERGE } = process.env;
for (const sha of [CI_BASE, CI_HEAD, CI_MERGE]) assert.match(sha ?? "", /^[a-f0-9]{40}$/);
const git = (args) =>
  execFileSync("git", ["--no-replace-objects", ...args], { encoding: "utf8" }).trim();
assert.equal(git(["rev-parse", "HEAD"]), CI_MERGE, "Docs checkout differs from the event merge");
assert.equal(
  git(["show", "-s", "--format=%P", "HEAD"]),
  `${CI_BASE} ${CI_HEAD}`,
  "Docs merge parents differ from the event base/head",
);

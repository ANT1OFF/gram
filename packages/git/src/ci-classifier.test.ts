import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCUMENTATION_POLICY } from "./ci-policy.ts";

it("the Actions entrypoint uses actual base policy/diff and defaults main/manual/errors to full", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gram-ci-entrypoint-"));
  const script = fileURLToPath(new URL("../../../tools/classify-ci.mjs", import.meta.url));
  const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const output = join(cwd, "output");
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Synthetic CI"]);
    git(["config", "user.email", "ci@example.test"]);
    mkdirSync(join(cwd, ".gram"));
    writeFileSync(join(cwd, "README.md"), "initial prose\n");
    writeFileSync(join(cwd, ".gram/merge-ci.json"), "{}\n");
    git(["add", "."]);
    git(["commit", "-qm", "no documentation policy"]);
    const unpolicied = git(["rev-parse", "HEAD"]);
    writeFileSync(
      join(cwd, ".gram/merge-ci.json"),
      JSON.stringify({ documentationPolicy: DOCUMENTATION_POLICY }),
    );
    git(["commit", "-qam", "new policy"]);
    const base = git(["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "README.md"), "edited prose\n");
    git(["commit", "-qam", "prose"]);
    const head = git(["rev-parse", "HEAD"]);
    const classify = (event: string, baseSha = base, headSha = head) => {
      writeFileSync(output, "");
      execFileSync(process.execPath, [script], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI_EVENT: event,
          CI_BASE: baseSha,
          CI_HEAD: headSha,
          GITHUB_OUTPUT: output,
        },
      });
      return readFileSync(output, "utf8");
    };
    expect(classify("pull_request")).toBe("kind=docs\n");
    expect(classify("pull_request", unpolicied)).toBe("kind=full\n");
    expect(classify("push")).toBe("kind=full\n");
    expect(classify("workflow_dispatch")).toBe("kind=full\n");
    expect(classify("pull_request", "c".repeat(40))).toBe("kind=full\n");
    expect(classify("pull_request", "--invalid")).toBe("kind=full\n");
    expect(classify("pull_request", base, base)).toBe("kind=full\n");
    writeFileSync(join(cwd, ".gram/merge-ci.json"), "{}\n");
    git(["commit", "-qam", "policy edit"]);
    expect(classify("pull_request", base, git(["rev-parse", "HEAD"]))).toBe("kind=full\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("the docs source step requires the actual event merge checkout and ordered base/head parents", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gram-ci-source-"));
  const script = fileURLToPath(new URL("../../../tools/check-ci-source.mjs", import.meta.url));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git(["init", "-q"]);
    git(["config", "user.name", "Synthetic CI"]);
    git(["config", "user.email", "ci@example.test"]);
    writeFileSync(join(cwd, "README.md"), "base\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]);
    writeFileSync(join(cwd, "README.md"), "head\n");
    git(["commit", "-qam", "head"]);
    const head = git(["rev-parse", "HEAD"]);
    const tree = git(["rev-parse", "HEAD^{tree}"]);
    const merge = execFileSync("git", ["commit-tree", tree, "-p", base, "-p", head], {
      cwd,
      input: "event merge\n",
      encoding: "utf8",
    }).trim();
    const verify = (baseSha = base, headSha = head, mergeSha = merge) =>
      execFileSync(process.execPath, [script], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI_BASE: baseSha, CI_HEAD: headSha, CI_MERGE: mergeSha },
      });
    expect(() => verify()).toThrow(); // A PR head checkout is insufficient.
    git(["checkout", "--detach", merge]);
    expect(verify()).toBe("");
    expect(() => verify(head, base)).toThrow();
    expect(() => verify(base, head, head)).toThrow();
    expect(() => verify("--invalid")).toThrow();
    expect(() => verify("d".repeat(40))).toThrow();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

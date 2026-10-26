import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciDiffArgs, classifyCiDiff, qualifiedCiResults } from "./ci-policy.ts";

const oid = "a".repeat(40);
const raw = (path: string, status = "M", before = "100644", after = "100644", target?: string) =>
  `:${before} ${after} ${oid} ${oid} ${status}\0${path}\0${target === undefined ? "" : `${target}\0`}`;

describe("conservative prose policy", () => {
  it.each(["README.md", "docs/README.md"])("allows audited ordinary prose %s", (path) => {
    expect(classifyCiDiff(raw(path))).toBe("docs");
  });
  it.each([
    "CONTRIBUTING.md",
    "docs/DEVELOPMENT.md",
    "docs/HANDOFF.md",
    "docs/WORKFLOW.md",
    "docs/ARCHITECTURE.md",
    "docs/AGENTS_AND_FEATURES.md",
    "docs/guides/local-cli.md",
    "docs/verification/docs-aware-ci.md",
    "docs/verification/archive/old/history.md",
    "docs/development/testing.md",
    "docs/development/ACCEPTANCE.md",
    "AGENTS.md",
    "CLAUDE.md",
    "docs/guides/AGENTS.md",
    "docs/guides/SKILL.md",
    "docs/orchestration/playbooks/cut-rc.md",
    "docs/PUBLIC_RELEASE.md",
    "docs/releases/README.md",
    "docs/releases/0.1.0-rc.3.md",
    "packages/git/README.md",
    "packages/git/src/fixtures/review-bot/README.md",
    "apps/desktop/assets/README.md",
    "apps/web/src/whats-new/release-notes.tsx",
    ".github/workflows/check.yml",
    ".gram/merge-ci.json",
    "tools/classify-ci.mjs",
    "packages/git/src/ci-policy.ts",
    "package.json",
    "bun.lock",
    ".node-version",
    ".bun-version",
    "patches/effect.patch",
    "notes.md",
    "docs/new-area/notes.md",
    "docs/../README.md",
    "docs/odd\nname.md",
  ])("requires application qualification for %s", (path) => {
    expect(classifyCiDiff(raw(path))).toBe("full");
  });
  it("includes additions/deletions and both sides of renames", () => {
    expect(classifyCiDiff(raw("README.md", "A", "000000"))).toBe("docs");
    expect(classifyCiDiff(raw("README.md", "D", "100644", "000000"))).toBe("docs");
    expect(classifyCiDiff(raw("README.md", "R100", "100644", "100644", "docs/README.md"))).toBe(
      "docs",
    );
    expect(classifyCiDiff(raw("package.json", "R80", "100644", "100644", "README.md"))).toBe(
      "full",
    );
    expect(classifyCiDiff(raw("README.md", "R80", "100644", "100644", "runtime.ts"))).toBe("full");
    expect(classifyCiDiff(raw("README.md") + raw("runtime.ts"))).toBe("full");
  });
  it.each([
    "",
    "\0",
    raw("README.md").slice(0, -1),
    raw("README.md", "T"),
    raw("README.md", "C100", "100644", "100644", "docs/copy.md"),
    raw("README.md", "R101", "100644", "100644", "docs/new.md"),
    raw("README.md", "R100"),
    raw("README.md", "M", "100644", "100755"),
    raw("README.md", "A", "000000", "120000"),
    raw("README.md", "M", "160000", "160000"),
    raw("README.md", "A"),
    raw("README.md") + "garbage\0",
  ])("fails closed for malformed/special diff %#", (input) => {
    expect(classifyCiDiff(input)).toBe("full");
  });
  it("classifies a real complete two-tip diff, including a deleted runtime file and executable prose", () => {
    const cwd = mkdtempSync(join(tmpdir(), "gram-ci-policy-"));
    const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git(["init", "-q"]);
      git(["config", "user.name", "Synthetic CI"]);
      git(["config", "user.email", "ci@example.test"]);
      writeFileSync(join(cwd, "README.md"), "ordinary prose\n");
      writeFileSync(join(cwd, "runtime.ts"), "export const value = 1;\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      writeFileSync(join(cwd, "README.md"), "edited prose\n");
      git(["commit", "-qam", "prose"]);
      const prose = git(["rev-parse", "HEAD"]);
      const diff = (head: string) =>
        execFileSync("git", ciDiffArgs(base, head), { cwd, encoding: "utf8" });
      expect(classifyCiDiff(diff(prose))).toBe("docs");
      // A newer actual base can differ in runtime even though merge-base...head is prose-only.
      git(["checkout", "-qb", "advanced-base", base]);
      writeFileSync(join(cwd, "runtime.ts"), "export const value = 2;\n");
      git(["commit", "-qam", "new base runtime"]);
      const advancedBase = git(["rev-parse", "HEAD"]);
      expect(
        classifyCiDiff(
          execFileSync("git", ciDiffArgs(advancedBase, prose), { cwd, encoding: "utf8" }),
        ),
      ).toBe("full");
      git(["checkout", "--detach", prose]);
      renameSync(join(cwd, "runtime.ts"), join(cwd, "renamed.md"));
      git(["add", "-A"]);
      git(["commit", "-qm", "runtime rename"]);
      expect(classifyCiDiff(diff(git(["rev-parse", "HEAD"])))).toBe("full");
      git(["reset", "--hard", prose]);
      git(["rm", "runtime.ts"]);
      git(["commit", "-qm", "runtime deletion"]);
      expect(classifyCiDiff(diff(git(["rev-parse", "HEAD"])))).toBe("full");
      git(["reset", "--hard", prose]);
      chmodSync(join(cwd, "README.md"), 0o755);
      git(["update-index", "--chmod=+x", "README.md"]);
      git(["commit", "-qm", "executable prose"]);
      expect(classifyCiDiff(diff(git(["rev-parse", "HEAD"])))).toBe("full");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("always-running qualification gate", () => {
  const full = {
    classify: "success",
    docs: "skipped",
    check: "success",
    e2e: "success",
    macos: "success",
  };
  const docs = {
    classify: "success",
    docs: "success",
    check: "skipped",
    e2e: "skipped",
    macos: "skipped",
  };
  it("accepts only the explicitly selected successful lane", () => {
    expect(qualifiedCiResults("full", full)).toBe(true);
    expect(qualifiedCiResults("docs", docs)).toBe(true);
    expect(qualifiedCiResults("full", docs)).toBe(false);
    expect(qualifiedCiResults("docs", full)).toBe(false);
    expect(qualifiedCiResults("", docs)).toBe(false);
    expect(qualifiedCiResults("unknown", full)).toBe(false);
  });
  it.each(["failure", "cancelled", "skipped", "", undefined])(
    "refuses non-successful required jobs: %s",
    (result) => {
      for (const name of ["classify", "check", "e2e", "macos"]) {
        expect(qualifiedCiResults("full", { ...full, [name]: result })).toBe(false);
      }
      for (const name of ["classify", "docs"]) {
        expect(qualifiedCiResults("docs", { ...docs, [name]: result })).toBe(false);
      }
    },
  );
});

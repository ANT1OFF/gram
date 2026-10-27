import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_LANES, ciDiffArgs, ciLanes, classifyCiDiff, qualifiedCiResults } from "./ci-policy.ts";

const oid = "a".repeat(40);
const raw = (path: string, status = "M", before = "100644", after = "100644", target?: string) =>
  `:${before} ${after} ${oid} ${oid} ${status}\0${path}\0${target === undefined ? "" : `${target}\0`}`;

const lanes = (input: string) => {
  const result = ciLanes(input);
  return result === "docs" ? "docs" : [...CI_LANES].filter((lane) => result.has(lane));
};
const ALL = ["static", "tests", "package", "e2e"];

describe("prose policy", () => {
  it.each([
    "README.md",
    "docs/README.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "CLAUDE.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "notes.md",
    ".github/pull_request_template.md",
    ".agents/skills/mock-build/SKILL.md",
    "docs/VERIFICATION.md",
    "docs/RELEASING.md",
    "docs/new-area/notes.md",
    "docs/images/how-it-works-dark.svg",
    "docs/design/mocks/new-entry/v1.html",
    "docs/design/mocks/new-entry/shots/a-dark.png",
  ])("runs only the docs lane for prose %s", (path) => {
    expect(classifyCiDiff(raw(path))).toBe("docs");
    expect(lanes(raw(path))).toBe("docs");
  });
  it.each([
    "packages/git/README.md",
    "packages/git/src/fixtures/review-bot/README.md",
    "tools/notes.md",
    "apps/web/src/whats-new/release-notes.tsx",
    ".github/workflows/check.yml",
    ".gram/merge-ci.json",
    "tools/classify-ci.mjs",
    "tools/qualify-ci.mjs",
    "tools/check/run.mjs",
    "tools/notices/generate.mjs",
    "packages/git/src/ci-policy.ts",
    "package.json",
    "bun.lock",
    ".node-version",
    ".bun-version",
    "patches/effect.patch",
    "LICENSE",
    ".agents/skills/other/script.mjs",
    "docs/../README.md",
    "./README.md",
    "docs//README.md",
    "docs/odd\nname.md",
    "docs/My Notes.md",
  ])("runs every lane for %s", (path) => {
    expect(classifyCiDiff(raw(path))).toBe("full");
    expect(lanes(raw(path))).toEqual(ALL);
  });
  it.each([
    ["packages/server/src/runtime/limit-wait-runtime.test.ts", ["static", "tests"]],
    ["apps/web/src/thread/request-cards.test.tsx", ["static", "tests"]],
    ["apps/web/scripts/e2e-timings.test.mjs", ["static", "tests"]],
    ["tools/release-stable/stable.test.mjs", ["static", "tests"]],
    ["tools/release-stable/stable.mjs", ["static", "tests"]],
    ["tools/check-docs.mjs", ["static", "tests"]],
    ["apps/web/e2e/approval-card-fit.spec.ts", ["static", "e2e"]],
    ["apps/web/e2e-real/flows.spec.ts", ["static"]],
    ["apps/web/pr-shots/shots.ts", ["static"]],
    ["docs/design/mocks/needs-you-home/v1.html", ["static", "e2e"]],
    ["docs/design/mocks/needs-you-home/brief.md", ["static", "e2e"]],
    ["docs/design/mocks/tokens.css", ["static", "tests"]],
    [".agents/skills/mock-build/kit/kit.js", ["static", "tests", "e2e"]],
    [".agents/skills/mock-build/templates/options.html", ["static", "tests"]],
    ["apps/desktop/src/main/ipc.ts", ["static", "tests", "package"]],
    ["apps/desktop/assets/README.md", ["static", "tests", "package"]],
    ["apps/web/src/thread/request-cards.tsx", ALL],
    ["packages/server/src/runtime/test-harness.ts", ALL],
    ["packages/server/src/runtime/limit-wait.ts", ALL],
  ])("runs only what %s can affect", (path, expected) => {
    expect(classifyCiDiff(raw(path))).toBe("full");
    expect(lanes(raw(path))).toEqual(expected);
  });
  it("runs the union of every path's lanes, and prose adds none", () => {
    expect(lanes(raw("README.md") + raw("apps/web/e2e/smoke.spec.ts"))).toEqual(["static", "e2e"]);
    expect(lanes(raw("apps/desktop/src/main/ipc.ts") + raw("apps/web/e2e/smoke.spec.ts"))).toEqual(
      ALL,
    );
    expect(lanes(raw("tools/check-docs.mjs") + raw("apps/web/src/app.tsx"))).toEqual(ALL);
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
    raw("apps/web/e2e/smoke.spec.ts", "M", "100644", "100755"),
    raw("packages/server/src/a.test.ts", "A", "000000", "120000"),
  ])("fails closed for malformed/special diff %#", (input) => {
    expect(classifyCiDiff(input)).toBe("full");
    expect(lanes(input)).toEqual(ALL);
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

const job = (lane: string, result: string | undefined) => ({ lane, result });

const run = (selected: ReadonlyArray<string>, docs = false) => [
  job("docs", docs ? "success" : "skipped"),
  ...["static", "tests", "tests", "package", ...Array(8).fill("e2e")].map((lane) =>
    job(lane, selected.includes(lane) ? "success" : "skipped"),
  ),
];
describe("always-running qualification gate", () => {
  it("accepts only the lanes classification selected, each successful, the rest skipped", () => {
    expect(qualifiedCiResults("code", ALL, "success", run(ALL))).toBe(true);
    expect(qualifiedCiResults("docs", [], "success", run([], true))).toBe(true);
    expect(
      qualifiedCiResults("code", ["static", "tests"], "success", run(["static", "tests"])),
    ).toBe(true);
    // A job skipped though its lane was selected, or run though it wasn't.
    expect(qualifiedCiResults("code", ALL, "success", run(["static", "tests"]))).toBe(false);
    expect(qualifiedCiResults("code", ["static"], "success", run(ALL))).toBe(false);
    expect(qualifiedCiResults("docs", [], "success", run(ALL))).toBe(false);
    expect(qualifiedCiResults("code", ALL, "success", run(ALL, true))).toBe(false);
    expect(qualifiedCiResults("docs", ALL, "success", run([], true))).toBe(false);
    expect(qualifiedCiResults("code", [], "success", run([]))).toBe(false);
    expect(qualifiedCiResults("", [], "success", run([], true))).toBe(false);
    expect(qualifiedCiResults("full", ALL, "success", run(ALL))).toBe(false);
    expect(qualifiedCiResults("code", ["static", "lint"], "success", run(["static"]))).toBe(false);
    expect(qualifiedCiResults("code", ["static", "static"], "success", run(["static"]))).toBe(
      false,
    );
    // A selected lane with no job, or a job of no known lane.
    expect(qualifiedCiResults("code", ["static"], "success", [job("docs", "skipped")])).toBe(false);
    expect(
      qualifiedCiResults("code", ALL, "success", [...run(ALL), job("unknown job x", "success")]),
    ).toBe(false);
  });
  it.each(["failure", "cancelled", "skipped", "", undefined])(
    "refuses non-successful required jobs: %s",
    (result) => {
      expect(qualifiedCiResults("code", ALL, result, run(ALL))).toBe(false);
      expect(qualifiedCiResults("docs", [], result, run([], true))).toBe(false);
      const full = run(ALL);
      for (let i = 1; i < full.length; i++) {
        const jobs = full.map((j, k) => (k === i ? job(j.lane, result) : j));
        expect(qualifiedCiResults("code", ALL, "success", jobs)).toBe(false);
      }
      const docs = run([], true).map((j, k) => (k === 0 ? job("docs", result) : j));
      expect(qualifiedCiResults("docs", [], "success", docs)).toBe(false);
    },
  );
});

import { describe, expect, it } from "@effect/vitest";
import type { PrStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciDiffArgs, classifyCiDiff, DOCUMENTATION_POLICY } from "./ci-policy.ts";
import { verifyMergeCi } from "./merge-ci.ts";
import { Proc } from "./proc.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const merge = "c".repeat(40);
const other = "d".repeat(40);
const badge: PrStatus = {
  number: 1,
  state: "OPEN",
  url: "https://github.com/example/project/pull/1",
  title: "Prose",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  baseRefOid: base,
  headRefOid: head,
  headRef: "prose",
};
const policy = {
  documentationPolicy: DOCUMENTATION_POLICY,
  workflows: [
    {
      path: ".github/workflows/check.yml",
      event: "pull_request",
      jobs: ["classify", "qualification", "check", "subscription-smoke"],
      docsJobs: ["classify", "qualification", "docs"],
    },
  ],
};
const sourceStep = (baseSha = base, headSha = head, mergeSha = merge) => ({
  name: `docs-source [base=${baseSha} head=${headSha} merge=${mergeSha}]`,
  number: 2,
  status: "completed",
  conclusion: "success",
});
const actionRun = (headSha = head) => ({
  id: 10,
  run_attempt: 1,
  head_sha: headSha,
  head_branch: "prose",
  path: ".github/workflows/check.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "success",
  // This association is mutable and deliberately disagrees with the immutable source in tests.
  pull_requests: [{ number: 1, base: { sha: base }, head: { sha: headSha } }],
});
const jobs = (headSha = head, step = sourceStep()) =>
  ["classify", "qualification", "docs", "check", "subscription-smoke"].map((name, index) => ({
    id: 100 + index,
    name,
    run_id: 10,
    run_attempt: 1,
    head_sha: headSha,
    status: "completed",
    conclusion: ["check", "subscription-smoke"].includes(name) ? "skipped" : "success",
    steps: name === "docs" ? [step] : [],
  }));
const currentPr = (baseSha = base, headSha = head) => ({
  number: 1,
  state: "open",
  base: { sha: baseSha },
  head: { sha: headSha, ref: "prose", repo: { full_name: "example/project" } },
});
const output = (body: unknown, status = 0, truncated = false) => ({
  status,
  truncated,
  stdout: JSON.stringify(body),
  stderr: "",
});

describe("review regressions: governance and unknown prose", () => {
  it.each([
    "docs/UPDATES.md",
    "docs/VERIFICATION.md",
    "docs/new-governance.md",
    "docs/verification/release-qualification.md",
  ])("requires full for %s", (path) => {
    expect(classifyCiDiff(`:100644 100644 ${base} ${head} M\0${path}\0`)).toBe("full");
  });
});

describe("immutable docs evidence", () => {
  for (const scenario of [
    "fresh",
    "absent source",
    "stale base",
    "stale head",
    "replayed merge",
    "wrong merge object",
    "one parent",
    "reversed parents",
    "extra parent",
    "source lookup failure",
    "truncated source",
    "source cancelled",
    "source missing number",
    "duplicate source",
    "missing job id",
    "wrong job head",
    "wrong job attempt",
    "wrong job run",
    "current base moved",
    "current head moved",
    "current fork",
    "current branch moved",
    "current PR closed",
    "current PR mismatch",
    "current lookup failure",
    "truncated current",
  ] as const) {
    it.effect(scenario, () =>
      Effect.gen(function* () {
        const layer = Layer.succeed(Proc, {
          run: (bin, args) => {
            if (bin === "git")
              return Effect.succeed({
                status: 0,
                truncated: false,
                stderr: "",
                stdout: `:100644 100644 ${base} ${head} M\0README.md\0`,
              });
            if (args.some((arg) => arg.startsWith("ref=")))
              return Effect.succeed(
                output({ data: { repository: { object: { text: JSON.stringify(policy) } } } }),
              );
            if (args[1]?.includes("actions/runs?"))
              return Effect.succeed(output({ total_count: 1, workflow_runs: [actionRun()] }));
            if (args[1]?.includes("/jobs?")) {
              const all = jobs();
              const docs = all[2]!;
              if (scenario === "absent source") docs.steps = [];
              if (scenario === "stale base") docs.steps = [sourceStep(other)];
              if (scenario === "stale head") docs.steps = [sourceStep(base, other)];
              if (scenario === "source cancelled") docs.steps[0]!.conclusion = "cancelled";
              if (scenario === "source missing number") docs.steps[0]!.number = 0;
              if (scenario === "duplicate source") docs.steps.push(sourceStep());
              if (scenario === "missing job id") docs.id = 0;
              if (scenario === "wrong job head") docs.head_sha = other;
              if (scenario === "wrong job attempt") docs.run_attempt = 2;
              if (scenario === "wrong job run") docs.run_id = 11;
              return Effect.succeed(output({ total_count: all.length, jobs: all }));
            }
            if (args[1]?.includes("/git/commits/")) {
              expect(args[1]).toBe(`repos/example/project/git/commits/${merge}`);
              const parents =
                scenario === "one parent"
                  ? [base]
                  : scenario === "reversed parents"
                    ? [head, base]
                    : scenario === "extra parent"
                      ? [base, head, other]
                      : [scenario === "replayed merge" ? other : base, head];
              return Effect.succeed(
                output(
                  {
                    sha: scenario === "wrong merge object" ? other : merge,
                    parents: parents.map((sha) => ({ sha })),
                  },
                  scenario === "source lookup failure" ? 1 : 0,
                  scenario === "truncated source",
                ),
              );
            }
            expect(args[1]).toBe("repos/example/project/pulls/1");
            const pr = currentPr(
              scenario === "current base moved" ? other : base,
              scenario === "current head moved" ? other : head,
            );
            if (scenario === "current fork") pr.head.repo.full_name = "example/fork";
            if (scenario === "current branch moved") pr.head.ref = "another";
            if (scenario === "current PR closed") pr.state = "closed";
            if (scenario === "current PR mismatch") pr.number = 2;
            return Effect.succeed(
              output(
                pr,
                scenario === "current lookup failure" ? 1 : 0,
                scenario === "truncated current",
              ),
            );
          },
        });
        const result = yield* verifyMergeCi("/repo", "example/project", badge).pipe(
          Effect.result,
          Effect.provide(layer),
        );
        if (scenario === "fresh")
          expect(result).toMatchObject({ _tag: "Success", success: "passing" });
        else expect(result).not.toMatchObject({ _tag: "Success", success: "passing" });
      }),
    );
  }

  it.effect(
    "refuses a previously green docs merge when a new clean merge deletes its untouched link target",
    () =>
      Effect.gen(function* () {
        const cwd = mkdtempSync(join(tmpdir(), "gram-ci-deleted-link-"));
        const git = (args: string[]) =>
          execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
        try {
          git(["init", "-q"]);
          git(["config", "user.name", "Synthetic CI"]);
          git(["config", "user.email", "ci@example.test"]);
          mkdirSync(join(cwd, "docs"));
          writeFileSync(join(cwd, "README.md"), "# Gram\n");
          writeFileSync(join(cwd, "docs/README.md"), "# Documentation map\n");
          git(["add", "."]);
          git(["commit", "-qm", "base A"]);
          const originalBase = git(["rev-parse", "HEAD"]);
          writeFileSync(join(cwd, "README.md"), "# Gram\n[Docs](docs/README.md)\n");
          git(["commit", "-qam", "head links existing target"]);
          const prHead = git(["rev-parse", "HEAD"]);
          const testedTree = git(["merge-tree", "--write-tree", originalBase, prHead]);
          const testedMerge = execFileSync(
            "git",
            ["commit-tree", testedTree, "-p", originalBase, "-p", prHead],
            { cwd, input: "event merge A H\n", encoding: "utf8" },
          ).trim();
          git(["checkout", "-qb", "new-base", originalBase]);
          git(["rm", "docs/README.md"]);
          git(["commit", "-qm", "base B deletes untouched target"]);
          const currentBase = git(["rev-parse", "HEAD"]);
          const currentTree = git(["merge-tree", "--write-tree", currentBase, prHead]);
          expect(git(["show", `${currentTree}:README.md`])).toContain("[Docs](docs/README.md)");
          expect(() => git(["show", `${currentTree}:docs/README.md`])).toThrow();
          const raw = execFileSync("git", ciDiffArgs(currentBase, prHead), {
            cwd,
            encoding: "utf8",
          });
          expect(classifyCiDiff(raw)).toBe("docs");
          const layer = Layer.succeed(Proc, {
            run: (bin, args) => {
              if (bin === "git")
                return Effect.succeed({ status: 0, truncated: false, stdout: raw, stderr: "" });
              if (args.some((arg) => arg.startsWith("ref=")))
                return Effect.succeed(
                  output({ data: { repository: { object: { text: JSON.stringify(policy) } } } }),
                );
              if (args[1]?.includes("actions/runs?"))
                return Effect.succeed(
                  output({ total_count: 1, workflow_runs: [actionRun(prHead)] }),
                );
              if (args[1]?.includes("/jobs?"))
                return Effect.succeed(
                  output({
                    total_count: 5,
                    jobs: jobs(prHead, sourceStep(originalBase, prHead, testedMerge)),
                  }),
                );
              if (args[1]?.includes("/git/commits/"))
                return Effect.succeed(
                  output({ sha: testedMerge, parents: [{ sha: originalBase }, { sha: prHead }] }),
                );
              return Effect.succeed(output(currentPr(currentBase, prHead)));
            },
          });
          const result = yield* verifyMergeCi(cwd, "example/project", {
            ...badge,
            baseRefOid: currentBase,
            headRefOid: prHead,
          }).pipe(Effect.result, Effect.provide(layer));
          expect(result).not.toMatchObject({ _tag: "Success", success: "passing" });
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      }),
  );
});

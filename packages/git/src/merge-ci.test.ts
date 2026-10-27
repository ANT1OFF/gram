import { describe, expect, it } from "@effect/vitest";
import type { PrStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ciDiffArgs, DOCUMENTATION_POLICY } from "./ci-policy.ts";
import { mergeCiForLaunch, verifyMergeCi } from "./merge-ci.ts";
import { Proc } from "./proc.ts";

const base = "a".repeat(40);
const head = "b".repeat(40);
const merge = "c".repeat(40);
const badge: PrStatus = {
  number: 1,
  state: "OPEN",
  url: "https://github.com/example/project/pull/1",
  title: "Prose",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: head,
  baseRefOid: base,
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
const diff = (path: string) => `:100644 100644 ${base} ${head} M\0${path}\0`;
const run = (id = 10, attempt = 1, status = "completed") => ({
  id,
  run_attempt: attempt,
  head_sha: head,
  head_branch: "prose",
  path: ".github/workflows/check.yml",
  event: "pull_request",
  status,
  conclusion: status === "completed" ? "success" : null,
});
const job = (name: string, conclusion = "success", more = {}) => ({
  id: name === "docs" ? 100 : 100 + name.length,
  name,
  conclusion,
  status: "completed",
  head_sha: head,
  run_id: 10,
  run_attempt: 1,
  steps:
    name === "docs"
      ? [
          {
            name: `docs-source [base=${base} head=${head} merge=${merge}]`,
            number: 2,
            status: "completed",
            conclusion: "success",
          },
        ]
      : [],
  ...more,
});

describe("documentation lane at the independent merge gate", () => {
  for (const scenario of [
    "docs",
    "runtime disguised as docs",
    "policy edit",
    "empty diff",
    "truncated diff",
    "diff error",
    "diff command failure",
    "missing docs job",
    "skipped docs job",
    "skipped qualification",
    "wrong head",
    "wrong attempt",
    "new queued run",
    "new rerun",
    "old policy",
    "full",
    "truncated jobs",
    "duplicate red docs job",
  ] as const) {
    it.effect(scenario, () =>
      Effect.gen(function* () {
        const calls: string[][] = [];
        const layer = Layer.succeed(Proc, {
          run: (bin, args) => {
            calls.push([...args]);
            if (bin === "git") {
              expect(args).toEqual(ciDiffArgs(base, head));
              if (scenario === "diff error") return Effect.die(new Error("missing objects"));
              return Effect.succeed({
                status: scenario === "diff command failure" ? 1 : 0,
                stderr: "",
                truncated: scenario === "truncated diff",
                stdout:
                  scenario === "empty diff"
                    ? ""
                    : diff(
                        scenario === "runtime disguised as docs"
                          ? "runtime.ts"
                          : scenario === "policy edit"
                            ? ".gram/merge-ci.json"
                            : "README.md",
                      ),
              });
            }
            let body: unknown;
            if (args.some((arg) => arg.startsWith("ref="))) {
              expect(args).toContain(`ref=${base}:.gram/merge-ci.json`);
              body = {
                data: {
                  repository: {
                    object: {
                      __typename: "Blob",
                      text: JSON.stringify(
                        scenario === "old policy"
                          ? {
                              workflows: policy.workflows.map(
                                ({ docsJobs: _docs, ...workflow }) => workflow,
                              ),
                            }
                          : policy,
                      ),
                    },
                  },
                },
              };
            } else if (args[1]?.includes("actions/runs?")) {
              const runs =
                scenario === "new queued run"
                  ? [run(), run(11, 1, "queued")]
                  : scenario === "new rerun"
                    ? [run(10, 2)]
                    : [run()];
              body = { total_count: runs.length, workflow_runs: runs };
            } else if (args[1]?.includes("/git/commits/")) {
              body = { sha: merge, parents: [{ sha: base }, { sha: head }] };
            } else if (args[1]?.includes("/pulls/")) {
              body = {
                number: 1,
                state: "open",
                base: { sha: base },
                head: { sha: head, ref: "prose", repo: { full_name: "example/project" } },
              };
            } else {
              expect(args[1]).toContain(
                scenario === "new rerun" ? "/attempts/2/jobs" : "/attempts/1/jobs",
              );
              let jobs = [
                job("classify"),
                job("qualification"),
                job("docs"),
                job("check", "skipped"),
                job("subscription-smoke", "skipped"),
              ];
              if (scenario === "full")
                jobs = [
                  job("classify"),
                  job("qualification"),
                  job("docs", "skipped"),
                  job("check"),
                  job("subscription-smoke"),
                ];
              if (scenario === "missing docs job") jobs = jobs.filter((j) => j.name !== "docs");
              if (scenario === "skipped docs job") jobs[2] = job("docs", "skipped");
              if (scenario === "skipped qualification") jobs[1] = job("qualification", "skipped");
              if (scenario === "wrong head") jobs[2] = job("docs", "success", { head_sha: base });
              if (scenario === "wrong attempt")
                jobs[2] = job("docs", "success", { run_attempt: 2 });
              if (scenario === "duplicate red docs job") jobs.push(job("docs", "failure"));
              body = { total_count: jobs.length + (scenario === "truncated jobs" ? 1 : 0), jobs };
            }
            return Effect.succeed({
              status: 0,
              stdout: JSON.stringify(body),
              stderr: "",
              truncated: false,
            });
          },
        });
        const result = yield* verifyMergeCi("/repo", "example/project", badge).pipe(
          Effect.result,
          Effect.provide(layer),
        );
        if (scenario === "docs" || scenario === "full")
          expect(result).toMatchObject({ _tag: "Success", success: "passing" });
        else expect(result).not.toMatchObject({ _tag: "Success", success: "passing" });
        if (scenario === "old policy")
          expect(calls.some((args) => args.includes("diff"))).toBe(false);
      }),
    );
  }
  it.effect(
    "allows actual full application qualification when diff objects are unavailable",
    () => {
      const layer = Layer.succeed(Proc, {
        run: (bin, args) => {
          let body: unknown;
          if (bin === "git")
            return Effect.succeed({
              status: 1,
              stdout: "",
              stderr: "missing objects",
              truncated: false,
            });
          if (args.some((arg) => arg.startsWith("ref=")))
            body = { data: { repository: { object: { text: JSON.stringify(policy) } } } };
          else if (args[1]?.includes("actions/runs?"))
            body = { total_count: 1, workflow_runs: [run()] };
          else
            body = {
              total_count: 5,
              jobs: [
                job("classify"),
                job("qualification"),
                job("check"),
                job("subscription-smoke"),
                job("docs", "skipped"),
              ],
            };
          return Effect.succeed({
            status: 0,
            stdout: JSON.stringify(body),
            stderr: "",
            truncated: false,
          });
        },
      });
      return verifyMergeCi("/repo", "example/project", badge).pipe(
        Effect.provide(layer),
        Effect.map((value) => expect(value).toBe("passing")),
      );
    },
  );
});

/** A Proc answering with `declared` as the base's policy and `jobs` in a run of `status`. */
const github = (
  declared: object,
  jobs: ReadonlyArray<ReturnType<typeof job>>,
  runStatus = "completed",
  calls: string[][] = [],
  changed?: string,
) =>
  Layer.succeed(Proc, {
    run: (bin, args) => {
      calls.push([...args]);
      if (bin === "git" && changed !== undefined)
        return Effect.succeed({ status: 0, stdout: diff(changed), stderr: "", truncated: false });
      let body: unknown;
      if (args.some((arg) => arg.startsWith("ref="))) {
        expect(args).toContain(`ref=${base}:.gram/merge-ci.json`);
        body = { data: { repository: { object: { text: JSON.stringify(declared) } } } };
      } else if (args[1]?.includes("actions/runs?"))
        body = { total_count: 1, workflow_runs: [run(10, 1, runStatus)] };
      else body = { total_count: jobs.length, jobs };
      return Effect.succeed({
        status: 0,
        stdout: JSON.stringify(body),
        stderr: "",
        truncated: false,
      });
    },
  });
const running = (name: string) => job(name, null as never, { status: "in_progress" });

describe("a local check of the head at the merge launch", () => {
  const e2e = ["e2e 1/2", "e2e 2/2"];
  const always = {
    ...policy,
    workflows: policy.workflows.map((workflow) => ({ ...workflow, alwaysJobs: e2e })),
  };

  it.effect("stands in for every job when the policy declares no alwaysJobs", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* mergeCiForLaunch("/repo", "example/project", badge, head).pipe(
        Effect.provide(github(policy, [], "in_progress", calls)),
      );
      expect(result).toBeUndefined();
      // Only the base's policy was read: no run or job evidence was asked for.
      expect(calls).toHaveLength(1);
    }),
  );

  it.effect("still waits for, then passes on, the jobs declared alwaysJobs", () =>
    Effect.gen(function* () {
      const launch = (jobs: ReadonlyArray<ReturnType<typeof job>>, runStatus = "completed") =>
        mergeCiForLaunch("/repo", "example/project", badge, head).pipe(
          Effect.provide(github(always, jobs, runStatus)),
        );
      const checked = [job("classify"), job("check")];
      expect(yield* launch([...checked, job("e2e 1/2"), running("e2e 2/2")], "in_progress")).toBe(
        "pending",
      );
      expect(yield* launch(checked, "in_progress")).toBe("pending");
      expect(yield* launch([...checked, job("e2e 1/2"), job("e2e 2/2", "failure")])).toBe(
        "failing",
      );
      // A finished run without the declared job never qualifies it.
      expect(yield* launch([...checked, job("e2e 1/2")])).toBe("failing");
      expect(yield* launch([...checked, job("e2e 1/2"), job("e2e 2/2")])).toBe("passing");
    }),
  );

  it.effect("verifies the whole declaration when the local check was of another head", () =>
    Effect.gen(function* () {
      const calls: string[][] = [];
      const result = yield* mergeCiForLaunch("/repo", "example/project", badge, base).pipe(
        Effect.result,
        Effect.provide(github(always, [job("e2e 1/2"), job("e2e 2/2")], "completed", calls)),
      );
      // classify, qualification, check and subscription-smoke are missing: not passing.
      expect(result).not.toMatchObject({ _tag: "Success", success: "passing" });
      expect(calls.some((args) => args[1]?.includes("actions/runs?"))).toBe(true);
    }),
  );
});

describe("lanes at the independent merge gate", () => {
  const e2e = ["e2e 1/2", "e2e 2/2"];
  const laned = {
    ...policy,
    workflows: [
      {
        path: ".github/workflows/check.yml",
        event: "pull_request",
        jobs: [
          "classify",
          "qualification",
          "check static",
          "check tests 1/1",
          "macos package",
          ...e2e,
        ],
        docsJobs: ["classify", "qualification", "docs"],
        laneJobs: {
          static: ["check static"],
          tests: ["check tests 1/1"],
          package: ["macos package"],
          e2e,
        },
        alwaysJobs: e2e,
      },
    ],
  };
  const verify = (changed: string, jobs: ReadonlyArray<ReturnType<typeof job>>, declared = laned) =>
    verifyMergeCi("/repo", "example/project", badge).pipe(
      Effect.provide(github(declared, jobs, "completed", [], changed)),
      Effect.result,
    );
  const ran = [job("classify"), job("qualification"), job("check static"), job("check tests 1/1")];
  const skipped = [job("macos package", "skipped"), ...e2e.map((name) => job(name, "skipped"))];

  it.effect("needs none of the jobs of a lane the diff can't affect, by its own reproduction", () =>
    Effect.gen(function* () {
      const test = "packages/server/src/a.test.ts";
      expect(yield* verify(test, [...ran, ...skipped])).toMatchObject({ success: "passing" });
      // A skipped matrix shows one job under its unexpanded name, and none under the declared ones.
      expect(
        yield* verify(test, [...ran, job("e2e ${{ matrix.shard }}/2", "skipped")]),
      ).toMatchObject({ success: "passing" });
      // The lanes it did select still have to pass.
      expect(
        yield* verify(test, [...ran.slice(0, 3), job("check tests 1/1", "skipped"), ...skipped]),
      ).toMatchObject({ success: "failing" });
    }),
  );

  it.effect("needs every lane's jobs for a change the diff says can reach them", () =>
    Effect.gen(function* () {
      for (const changed of [
        "packages/server/src/runtime.ts",
        "docs/../x.ts",
        ".github/workflows/check.yml",
      ])
        expect(yield* verify(changed, [...ran, ...skipped])).toMatchObject({ success: "failing" });
      expect(yield* verify("apps/desktop/src/main/ipc.ts", [...ran, ...skipped])).toMatchObject({
        success: "failing",
      });
      expect(
        yield* verify("apps/desktop/src/main/ipc.ts", [
          ...ran,
          job("macos package"),
          ...e2e.map((name) => job(name, "skipped")),
        ]),
      ).toMatchObject({ success: "passing" });
    }),
  );

  it.effect("needs every job when the base declares no lanes", () =>
    Effect.gen(function* () {
      const { laneJobs: _, ...bare } = laned.workflows[0]!;
      expect(
        yield* verify("packages/server/src/a.test.ts", [...ran, ...skipped], {
          ...laned,
          workflows: [bare],
        } as typeof laned),
      ).toMatchObject({ success: "failing" });
    }),
  );
});

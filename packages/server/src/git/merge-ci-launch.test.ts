import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_CHARTER, WorkspaceId, type PrStatus } from "@gram/contracts";
import { Pr, PrLive, Proc, ReviewBots, Tools } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadStore } from "../persistence/thread-store.ts";
import { RuntimeTestLayer } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { GitRefresh } from "./platform.ts";
import { GitStatePublisher } from "./publisher.ts";
import { MergeWhenReady, MergeWhenReadyLive } from "./merge-when-ready.ts";
import { waitReal } from "../orchestration/test-harness.ts";

// Public synthetic shape, with the incident's exact timing/rollup relationship. No private logs.
const HEAD = "275df5d2b37ddb496b0d7c65c7a10294c00519d7";
const base = "d7f7d478cc5b1d44379da3fa6f4c1ef6ca259604";
const published: PrStatus = {
  number: 5,
  state: "OPEN",
  url: "https://github.com/example/project/pull/5",
  title: "CI gate",
  isDraft: false,
  checks: "passing",
  headMatches: true,
  aheadOfPr: false,
  headRefOid: HEAD,
  baseRefOid: base,
  headRef: "feat/topic",
  mergeState: "CLEAN",
};
const policy = {
  workflows: [
    {
      path: ".github/workflows/check.yml",
      event: "pull_request",
      jobs: ["check", "subscription-smoke"],
    },
    { path: ".github/workflows/scaffold.yml", event: "pull_request", jobs: ["scaffold"] },
  ],
};
const run = (id: number, path: string, status = "completed", head = HEAD) => ({
  id,
  path: `.github/workflows/${path}.yml`,
  head_sha: head,
  head_branch: "feat/topic",
  event: "pull_request",
  run_attempt: 1,
  status,
  conclusion: status === "completed" ? "success" : null,
});
const job = (name: string, run_id: number, more: Record<string, unknown> = {}) => ({
  name,
  run_id,
  run_attempt: 1,
  head_sha: HEAD,
  status: "completed",
  conclusion: "success",
  ...more,
});

describe("actual merge launch with GitHub CI evidence", () => {
  for (const scenario of [
    "queued",
    "in_progress",
    "registered in_progress",
    "missing workflow",
    "previous head",
    "missing job",
    "skipped job",
    "cancelled job",
    "wrong job head",
    "new queued execution",
    "rerun queued",
    "truncated runs",
    "policy failure",
    "no policy queued",
    "required optional queued",
    "custom green",
    "invalid policy",
    "docs green",
    "docs stale merge source",
    "green",
  ] as const) {
    it.live(`launch follows exact-head CI evidence: ${scenario}`, () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-merge-ci-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const calls: string[][] = [];
        let policyReads = 0;
        let verificationEnded = false;
        const proc = Layer.succeed(Proc, {
          run: (_bin, args) =>
            Effect.sync(() => {
              calls.push([...args]);
              let body: unknown;
              let status = 0;
              if (_bin === "git" && args.includes("diff")) {
                expect(args).toContain(base);
                expect(args).toContain(HEAD);
                return {
                  status: 0,
                  stdout: `:100644 100644 ${base} ${HEAD} M\0README.md\0`,
                  stderr: "",
                  truncated: false,
                };
              }
              if (args[0] === "rev-parse")
                return { status: 1, stdout: "", stderr: "", truncated: false };
              if (args[0] === "pr") {
                verificationEnded = true;
                return { status: 0, stdout: "", stderr: "", truncated: false };
              }
              if (args.some((arg) => arg.startsWith("ref="))) {
                policyReads++;
                expect(args).toContain(`ref=${base}:.gram/merge-ci.json`);
                if (scenario === "invalid policy") verificationEnded = true;
                if (scenario === "policy failure") {
                  status = 1;
                  verificationEnded = true;
                }
                body = {
                  data: {
                    repository: {
                      object: ["no policy queued", "required optional queued"].includes(scenario)
                        ? null
                        : {
                            __typename: "Blob",
                            text: JSON.stringify(
                              scenario === "invalid policy"
                                ? { workflows: [] }
                                : scenario === "custom green"
                                  ? {
                                      workflows: [
                                        {
                                          path: ".github/workflows/check.yml",
                                          event: "pull_request",
                                          jobs: ["Individual CI (linux)"],
                                        },
                                      ],
                                    }
                                  : scenario.startsWith("docs ")
                                    ? {
                                        documentationPolicy: "gram-prose-v2",
                                        workflows: [
                                          {
                                            ...policy.workflows[0]!,
                                            jobs: [
                                              "classify",
                                              "qualification",
                                              "check",
                                              "subscription-smoke",
                                            ],
                                            docsJobs: ["classify", "qualification", "docs"],
                                          },
                                          policy.workflows[1]!,
                                        ],
                                      }
                                    : policy,
                            ),
                          },
                    },
                  },
                };
              } else if (args[1]?.includes("actions/runs?")) {
                expect(args[1]).toContain(`head_sha=${HEAD}`);
                let runs = [run(38076279307, "check"), run(38076279308, "scaffold")];
                if (
                  [
                    "queued",
                    "in_progress",
                    "registered in_progress",
                    "no policy queued",
                    "required optional queued",
                  ].includes(scenario)
                )
                  runs[0] = run(
                    38076279307,
                    "check",
                    ["in_progress", "registered in_progress"].includes(scenario)
                      ? "in_progress"
                      : "queued",
                  );
                if (scenario === "missing workflow") runs = [runs[1]!];
                if (scenario === "previous head")
                  runs[0] = run(38076279307, "check", "completed", "old-green");
                if (scenario === "new queued execution")
                  runs.push(run(38076279309, "check", "queued"));
                if (scenario === "rerun queued")
                  runs[0] = { ...run(38076279307, "check", "queued"), run_attempt: 2 };
                body = {
                  total_count: runs.length + (scenario === "truncated runs" ? 1 : 0),
                  workflow_runs: runs,
                };
                verificationEnded = ![
                  "green",
                  "custom green",
                  "required optional queued",
                  "docs green",
                ].includes(scenario);
              } else if (args[1]?.includes("/attempts/1/jobs")) {
                let jobs = args[1].includes("38076279307")
                  ? [job("check", 38076279307), job("subscription-smoke", 38076279307)]
                  : [job("scaffold", 38076279308)];
                if (scenario === "custom green" && jobs[0]?.name === "check")
                  jobs = [job("Individual CI (linux)", 38076279307)];
                if (scenario.startsWith("docs ") && jobs[0]?.name === "check")
                  jobs = [
                    job("classify", 38076279307),
                    job("qualification", 38076279307),
                    job("docs", 38076279307, {
                      id: 500,
                      steps: [
                        {
                          name: `docs-source [base=${base} head=${HEAD} merge=${"c".repeat(40)}]`,
                          number: 2,
                          status: "completed",
                          conclusion: "success",
                        },
                      ],
                    }),
                    job("check", 38076279307, { conclusion: "skipped" }),
                    job("subscription-smoke", 38076279307, { conclusion: "skipped" }),
                  ];
                if (jobs[0]?.name === "check") {
                  if (scenario === "missing job") jobs = [jobs[0]!];
                  if (scenario === "skipped job")
                    jobs[0] = job("check", 38076279307, { conclusion: "skipped" });
                  if (scenario === "cancelled job")
                    jobs[0] = job("check", 38076279307, { conclusion: "cancelled" });
                  if (scenario === "wrong job head")
                    jobs[0] = job("check", 38076279307, { head_sha: "old-green" });
                }
                body = { total_count: jobs.length, jobs };
              } else if (args[1]?.includes("/git/commits/")) {
                body = {
                  sha: "c".repeat(40),
                  parents: [
                    { sha: scenario === "docs stale merge source" ? "a".repeat(40) : base },
                    { sha: HEAD },
                  ],
                };
              } else if (args[1]?.includes("/pulls/")) {
                body = {
                  number: 5,
                  state: "open",
                  base: { sha: base },
                  head: { sha: HEAD, ref: "feat/topic", repo: { full_name: "example/project" } },
                };
              } else {
                // The provider's native rollup has only the two completed scaffold contexts, exactly
                // the pre-start registration gap. The current-head application workflow exists above.
                body = {
                  data: {
                    e0: {
                      pullRequest: {
                        ...published,
                        headRefName: "feat/topic",
                        baseRefName: "main",
                        headRefOid: HEAD,
                        baseRefOid: base,
                        mergeStateStatus: "CLEAN",
                        commits: {
                          nodes: [
                            {
                              commit: {
                                statusCheckRollup: {
                                  contexts: {
                                    nodes: [
                                      {
                                        __typename: "CheckRun",
                                        name: "scaffold",
                                        status: "COMPLETED",
                                        conclusion: "SUCCESS",
                                        isRequired: scenario === "required optional queued",
                                      },
                                      {
                                        __typename: "CheckRun",
                                        name: "scaffold",
                                        status: "COMPLETED",
                                        conclusion: "SUCCESS",
                                        isRequired: false,
                                      },
                                      ...(scenario === "registered in_progress"
                                        ? [
                                            {
                                              __typename: "CheckRun",
                                              name: "check",
                                              status: "IN_PROGRESS",
                                              conclusion: null,
                                              isRequired: false,
                                            },
                                          ]
                                        : []),
                                    ],
                                  },
                                },
                              },
                            },
                          ],
                        },
                        reviews: { nodes: [] },
                        comments: { nodes: [] },
                        reviewThreads: { nodes: [] },
                      },
                    },
                  },
                };
              }
              return { status, stdout: JSON.stringify(body), stderr: "", truncated: false };
            }),
        });
        const provider = PrLive.pipe(
          Layer.provide(
            Layer.mergeAll(
              proc,
              ReviewBots.layer,
              Layer.succeed(Tools, {
                ghReady: Effect.succeed(true),
                present: () => Effect.succeed(true),
                check: Effect.succeed({ git: true, gh: true, ghAuthed: true, claude: false }),
              }),
            ),
          ),
        );
        const publisher = Layer.succeed(GitStatePublisher, {
          badgeFor: () => Effect.succeed(published),
          stateFor: () => Effect.succeed(undefined),
          extraBadgesFor: () => Effect.succeed([]),
          watchPrs: () => Effect.void,
          watchedBadge: () => Effect.succeed(undefined),
          lookupPr: () => Effect.succeed(Option.some(published)),
          stateForThread: () => Effect.succeed(undefined),
          refresh: () => Effect.void,
          reconcile: () => Effect.void,
          checksRead: () => Effect.void,
          sweep: Effect.void,
          sync: Effect.void,
          hold: () => Effect.succeed(Effect.void),
          observe: () => Effect.void,
        });
        const layer = MergeWhenReadyLive.pipe(
          Layer.provideMerge(provider),
          Layer.provideMerge(proc),
          Layer.provideMerge(publisher),
          Layer.provideMerge(GitRefresh.layer),
          Layer.provideMerge(RuntimeTestLayer),
        );
        yield* Effect.gen(function* () {
          const runtimes = yield* ThreadRuntimes;
          const store = yield* ThreadStore;
          const thread = yield* runtimes.create({
            projectRoot: dir,
            checkout: { kind: "main", path: dir },
          });
          yield* Effect.addFinalizer(() => runtimes.close(thread.id).pipe(Effect.ignore));
          const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("ci-test");
          yield* store.putWorkspace({
            workspace: {
              id: workspaceId,
              name: "CI",
              projectIds: [thread.projectId],
              homeProjectId: thread.projectId,
              createdAt: 1,
            },
            charter: { ...DEFAULT_CHARTER, mergeReviewPolicy: "solo" },
          });
          yield* runtimes.updateThread(thread.id, (t) => ({
            ...t,
            workspaceId,
            boundPr: {
              repo: "example/project",
              number: 5,
              monitor: true,
              mergeWhenReady: { method: "squash", allowedBy: "user", setAt: 1 },
            },
          }));
          const pr = yield* Pr;
          // Warm the actual provider cache. The publisher retains the earlier green badge,
          // even when the registered-running variant now reads pending from GitHub.
          expect(
            yield* pr.status(dir, { repo: "example/project", number: 5, reviews: true }),
          ).toMatchObject({
            checks: scenario === "registered in_progress" ? "pending" : "passing",
          });
          yield* (yield* MergeWhenReady).check(thread.id);
          yield* waitReal(
            "CI verification or incorrect launch",
            Effect.sync(() => verificationEnded || calls.some((args) => args[0] === "pr")),
          );
          // Wait for the service's launched fiber to settle by acquiring its serial lock.
          yield* (yield* MergeWhenReady).mutate(thread.id, Effect.void);
          const merges = calls.filter((args) => args[0] === "pr");
          if (
            ["green", "custom green", "required optional queued", "docs green"].includes(scenario)
          ) {
            yield* waitReal(
              "merge intent completed",
              store
                .getThread(thread.id)
                .pipe(Effect.map((t) => t.boundPr?.mergeWhenReady === undefined)),
            );
            expect(merges).toEqual([
              [
                "pr",
                "merge",
                "5",
                "--squash",
                "--match-head-commit",
                HEAD,
                "--repo",
                "example/project",
              ],
            ]);
            expect(policyReads).toBeGreaterThan(0);
            if (scenario === "required optional queued")
              expect(calls.some((args) => args[1]?.includes("actions/runs?"))).toBe(false);
          } else {
            expect(merges).toEqual([]);
            expect((yield* store.getThread(thread.id)).boundPr?.mergeWhenReady).toBeDefined();
          }
        }).pipe(Effect.scoped, Effect.provide(layer));
      }).pipe(Effect.scoped),
    );
  }
});

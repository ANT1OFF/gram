// `ciStuck`'s GitHub reads (`CiJobsLive`) over a fake `gh` and a fake `Pr`, and its judgement
// (`judgeCiStuck`): which calls a look makes, what it reads from them, and that a `gh` that can't be
// reached is "couldn't tell", never a finding or a failure.
import { describe, expect, it } from "@effect/vitest";
import { Pr, type PrCheck, PrLookupError, Proc, ProcSpawnError, type SeenChecks } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { GhBudget } from "../github/budget.ts";
import { CiJobs, CiJobsLive, judgeCiStuck } from "./ci-stuck.ts";

interface Fake {
  /** By API path: what `gh api` prints and its exit code; absent, gh can't be started. */
  readonly api: Map<string, { readonly status: number; readonly body: string }>;
  readonly calls: Array<string>;
  seen?: SeenChecks | undefined;
  checks?: ReadonlyArray<PrCheck> | undefined;
  prReads: number;
}

const fake = (): Fake => ({ api: new Map(), calls: [], prReads: 0 });

const layerOf = (f: Fake) =>
  CiJobsLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        GhBudget.layer,
        Layer.succeed(Proc, {
          run: (_bin, args) =>
            Effect.suspend(() => {
              const path = args[1] ?? "";
              f.calls.push(path);
              const answer = f.api.get(path);
              if (answer === undefined) {
                return Effect.fail(new ProcSpawnError({ bin: "gh", message: "gh: not found" }));
              }
              return Effect.succeed({
                status: answer.status,
                stdout: answer.status === 0 ? answer.body : "",
                stderr: answer.status === 0 ? "" : answer.body,
                truncated: false,
              });
            }),
        }),
        Layer.succeed(Pr, {
          status: () => Effect.die("not used"),
          detail: () => Effect.die("not used"),
          prime: () => Effect.void,
          seenChecks: () => Effect.sync(() => f.seen),
          checks: () =>
            Effect.suspend(() => {
              f.prReads += 1;
              return f.checks === undefined
                ? Effect.fail(new PrLookupError({ message: "GitHub CLI not available" }))
                : Effect.succeed(f.checks);
            }),
        } as unknown as Pr["Service"]),
      ),
    ),
  );

const RUN = "repos/acme/app/actions/runs/55";
const JOBS = `${RUN}/jobs?per_page=100`;
const json = (value: unknown) => ({ status: 0, body: JSON.stringify(value) });

const check = (over: Partial<PrCheck>): PrCheck => ({
  name: "build",
  status: "pending",
  link: "https://github.com/acme/app/actions/runs/55/job/901",
  runId: "55",
  phase: "queued",
  ...over,
});

describe("CiJobsLive", () => {
  it.effect("reads a run's queued jobs in one call, with the time GitHub queued them", () => {
    const f = fake();
    f.api.set(
      JOBS,
      json({
        jobs: [
          {
            id: 901,
            name: "macos",
            status: "queued",
            created_at: "2026-11-03T10:00:00Z",
            started_at: null,
            html_url: "https://github.com/acme/app/actions/runs/55/job/901",
          },
          { id: 902, name: "linux", status: "in_progress", created_at: "2026-11-03T10:00:00Z" },
        ],
      }),
    );
    return Effect.gen(function* () {
      const jobs = yield* CiJobs;
      const state = yield* jobs.run("/repo", "acme/app", 55);
      expect(state).toEqual({
        queued: [
          {
            key: "901",
            name: "macos",
            url: "https://github.com/acme/app/actions/runs/55/job/901",
            since: Date.parse("2026-11-03T10:00:00Z"),
          },
        ],
      });
      expect(f.calls).toEqual([JOBS]);
      // Another wake on the same run, moments later, is answered from that read.
      yield* jobs.run("/repo", "acme/app", 55);
      expect(f.calls).toHaveLength(1);
      yield* TestClock.adjust("21 seconds");
      yield* jobs.run("/repo", "acme/app", 55);
      expect(f.calls).toHaveLength(2);
    }).pipe(Effect.provide(layerOf(f)));
  });

  it.effect("asks the run itself only once nothing of it is in flight", () => {
    const f = fake();
    f.api.set(JOBS, json({ jobs: [] }));
    f.api.set(
      RUN,
      json({
        id: 55,
        name: "CI",
        status: "completed",
        conclusion: "action_required",
        html_url: "u",
      }),
    );
    f.api.set(
      "repos/acme/app/actions/runs/56/jobs?per_page=100",
      json({ jobs: [{ id: 1, name: "a", status: "completed" }] }),
    );
    f.api.set(
      "repos/acme/app/actions/runs/56",
      json({ id: 56, status: "completed", conclusion: "cancelled" }),
    );
    f.api.set("repos/acme/app/actions/runs/57/jobs?per_page=100", {
      status: 1,
      body: "gh: Not Found (HTTP 404)",
    });
    return Effect.gen(function* () {
      const jobs = yield* CiJobs;
      expect(yield* jobs.run("/repo", "acme/app", 55)).toEqual({
        queued: [],
        approval: { name: "CI", url: "u" },
      });
      expect(f.calls).toEqual([JOBS, RUN]);
      expect(yield* jobs.run("/repo", "acme/app", 56)).toEqual({
        queued: [],
        completed: "cancelled",
      });
      expect(yield* jobs.run("/repo", "acme/app", 57)).toBeNull();
    }).pipe(Effect.provide(layerOf(f)));
  });

  it.effect(
    "a gh that can't be reached, or can't read the PR, says nothing and fails nothing",
    () => {
      const f = fake();
      return Effect.gen(function* () {
        const jobs = yield* CiJobs;
        expect(yield* jobs.run("/repo", "acme/app", 55)).toBeUndefined();
        expect(yield* jobs.pr("/repo", "acme/app", 7)).toBeUndefined();
        expect(f.prReads).toBe(1);
      }).pipe(Effect.provide(layerOf(f)));
    },
  );

  it.effect(
    "a PR's checks read in the last minute, by anyone, answer without asking GitHub",
    () => {
      const f = fake();
      f.seen = {
        checks: [
          check({ startedAt: "2026-11-03T10:00:00Z" }),
          check({
            name: "lint",
            phase: "running",
            link: "https://github.com/acme/app/actions/runs/55/job/902",
          }),
          // Not an Actions job: another provider's status, which no runner of ours picks up.
          { name: "external", status: "pending", link: "https://ci.example/1", phase: "queued" },
        ],
        at: 0,
      };
      return Effect.gen(function* () {
        const jobs = yield* CiJobs;
        expect(yield* jobs.pr("/repo", "acme/app", 7)).toEqual({
          queued: [
            {
              key: "901",
              name: "build",
              url: "https://github.com/acme/app/actions/runs/55/job/901",
              since: Date.parse("2026-11-03T10:00:00Z"),
            },
          ],
        });
        expect(f.prReads).toBe(0);
        expect(f.calls).toEqual([]);
        // Older than a minute: read again, through `Pr.checks` and its shared cache.
        yield* TestClock.adjust("61 seconds");
        f.checks = [];
        f.api.set(
          "repos/acme/app/actions/runs?status=action_required&per_page=20",
          json({ workflow_runs: [] }),
        );
        expect(yield* jobs.pr("/repo", "acme/app", 7)).toEqual({ queued: [] });
        expect(f.prReads).toBe(1);
      }).pipe(Effect.provide(layerOf(f)));
    },
  );

  it.effect("a PR with no Actions check finds a fork's run awaiting approval on its head", () => {
    const f = fake();
    f.checks = [];
    f.api.set(
      "repos/acme/app/actions/runs?status=action_required&per_page=20",
      json({
        workflow_runs: [
          {
            id: 70,
            name: "CI",
            status: "completed",
            conclusion: "action_required",
            head_sha: "other",
          },
          {
            id: 71,
            name: "CI",
            status: "completed",
            conclusion: "action_required",
            head_sha: "abc",
            html_url: "https://github.com/acme/app/actions/runs/71",
          },
        ],
      }),
    );
    f.api.set("repos/acme/app/pulls/76", json({ head: { sha: "abc" } }));
    return Effect.gen(function* () {
      const jobs = yield* CiJobs;
      expect(yield* jobs.pr("/repo", "acme/app", 76)).toEqual({
        queued: [],
        approval: { name: "CI", url: "https://github.com/acme/app/actions/runs/71" },
      });
      expect(f.calls).toEqual([
        "repos/acme/app/actions/runs?status=action_required&per_page=20",
        "repos/acme/app/pulls/76",
      ]);
    }).pipe(Effect.provide(layerOf(f)));
  });
});

describe("judgeCiStuck", () => {
  const spec = { kind: "ciStuck", repo: "acme/app", pr: 7, queuedMinutes: 15 } as const;
  const job = { key: "901", name: "macos", url: "u" };

  it("counts a job GitHub gave no time for from when a look first saw it, kept in `seen`", () => {
    const first = judgeCiStuck(spec, { queued: [job] }, undefined, 1_000);
    expect(first).toEqual({ met: false, seen: { "901": "1000" } });
    expect(judgeCiStuck(spec, { queued: [job] }, { "901": "1000" }, 1_000 + 14 * 60_000)).toEqual({
      met: false,
      seen: { "901": "1000" },
    });
    expect(judgeCiStuck(spec, { queued: [job] }, { "901": "1000" }, 1_000 + 15 * 60_000)).toEqual({
      met: true,
      facts: { repo: "acme/app", pr: "7", job: "macos", queued: "15 min, no runner", url: "u" },
    });
    // Picked up: nothing queued, and nothing kept.
    expect(judgeCiStuck(spec, { queued: [] }, { "901": "1000" }, 2_000_000)).toEqual({
      met: false,
      seen: {},
    });
  });

  it("names the job queued longest, and how many more are", () => {
    const look = judgeCiStuck(
      spec,
      {
        queued: [
          { ...job, since: 0 },
          { key: "902", name: "windows", url: "w", since: -60_000 },
        ],
      },
      undefined,
      20 * 60_000,
    );
    expect(look).toMatchObject({
      met: true,
      facts: { job: "windows", queued: "21 min, no runner", alsoQueued: "1" },
    });
  });
});

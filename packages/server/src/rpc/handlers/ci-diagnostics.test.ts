import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { CiJobDiagnostic, type ProjectId, type Thread, type ThreadId } from "@gram/contracts";
import { Pr, Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GitStatePublisher } from "../../git/publisher.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { ciDiagnosticHandlers } from "./ci-diagnostics.ts";

const dir = mkdtempSync(join(tmpdir(), "gram-ci-rpc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const head = "a".repeat(40);
const thread: Thread = {
  id: "synthetic-ci" as ThreadId,
  projectId: "synthetic-project" as ProjectId,
  title: "CI",
  userNamed: true,
  model: { agent: "claude", model: "haiku" },
  mode: "default",
  checkout: { kind: "main", path: dir },
  labels: [],
  pinned: false,
  parked: false,
  unread: false,
  createdAt: 0,
  lastActivityAt: 0,
  boundPr: { repo: "example/app", number: 7, monitor: false },
};
const { boundPr: _launchBinding, ...unboundThread } = thread;
const selection = { repo: "example/app", number: 7, headOid: head, runId: "12", jobId: "34" };
const link = "https://github.com/example/app/actions/runs/12/job/34";

const harness = (
  initial = thread,
  options: {
    duringFetch?: () => Thread;
    branchTarget?: () => { repo: string; number: number } | undefined;
    duringTargetLookup?: () => Thread;
  } = {},
) => {
  let current = initial;
  let threadReads = 0;
  let runReads = 0;
  let targetReads = 0;
  const ghCalls: string[][] = [];
  const proc: ProcShape = {
    run: (bin, args) =>
      Effect.sync(() => {
        expect(bin).toBe("gh");
        ghCalls.push([...args]);
        const path = args[0] === "pr" ? "pr" : args[1];
        if (path === "repos/example/app/actions/runs/12" && ++runReads === 2 && options.duringFetch)
          current = options.duringFetch();
        if (path === "repos/example/app/actions/jobs/34/logs")
          return { status: 0, stdout: "##[error]test failed", stderr: "", truncated: false };
        const body =
          path === "pr"
            ? { headRefOid: head, statusCheckRollup: [{ detailsUrl: link }] }
            : path === "repos/example/app/actions/runs/12"
              ? { id: 12, run_attempt: 2, head_sha: head }
              : path === "repos/example/app/actions/runs/12/attempts/2/jobs?per_page=100"
                ? {
                    total_count: 1,
                    jobs: [
                      {
                        id: 34,
                        run_id: 12,
                        head_sha: head,
                        name: "test",
                        status: "completed",
                        conclusion: "failure",
                        check_run_url: "https://api.github.com/repos/example/app/check-runs/56",
                        steps: [{ name: "Test", conclusion: "failure" }],
                      },
                    ],
                  }
                : path === "repos/example/app/check-runs/56"
                  ? { id: 56, head_sha: head, details_url: link }
                  : path === "repos/example/app/check-runs/56/annotations?per_page=10"
                    ? [
                        {
                          annotation_level: "failure",
                          message:
                            "AssertionError: test failed\nAuthorization: Bearer invented-private-token",
                        },
                      ]
                    : undefined;
        if (body === undefined) throw new Error("Unexpected synthetic gh request");
        return { status: 0, stdout: JSON.stringify(body), stderr: "", truncated: false };
      }),
  };
  const handlers = ciDiagnosticHandlers.pipe(
    Effect.provideService(ThreadStore, {
      getThread: () =>
        Effect.sync(() => {
          threadReads++;
          return current;
        }),
    } as unknown as ThreadStore["Service"]),
    Effect.provideService(GitStatePublisher, {
      stateFor: () =>
        Effect.sync(() => {
          if (++targetReads === 2 && options.duringTargetLookup)
            current = options.duringTargetLookup();
          const target = options.branchTarget?.();
          return target
            ? {
                pr: {
                  number: target.number,
                  url: `https://github.com/${target.repo}/pull/${target.number}`,
                },
              }
            : undefined;
        }),
    } as unknown as GitStatePublisher["Service"]),
    Effect.provideService(Pr, {
      status: () => Effect.succeed(undefined),
    } as unknown as Pr["Service"]),
    Effect.provideService(Proc, proc),
  );
  return { handlers, calls: ghCalls, threadReads: () => threadReads };
};

describe("git.prCheckDiagnostic RPC handler", () => {
  it.effect(
    "resolves only the bound PR and returns schema-valid redacted provenance without writes",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const handlers = yield* h.handlers;
        const result = yield* handlers["git.prCheckDiagnostic"]({ threadId: thread.id, selection });
        expect(Schema.decodeUnknownSync(CiJobDiagnostic)(result)).toMatchObject({
          repo: "example/app",
          number: 7,
          headOid: head,
          runId: "12",
          jobId: "34",
          attempt: 2,
        });
        expect(JSON.stringify(result)).not.toContain("invented-private-token");
        expect(
          h.calls.every(
            (args) =>
              args[0] === "pr" ||
              (args[0] === "api" && args[args.indexOf("--hostname") + 1] === "github.com"),
          ),
        ).toBe(true);
      }),
  );
  it.effect("refuses a rebind rather than looking up client-selected repository metadata", () =>
    Effect.gen(function* () {
      const h = harness({ ...thread, boundPr: { repo: "other/app", number: 7, monitor: false } });
      const handlers = yield* h.handlers;
      const error = yield* handlers["git.prCheckDiagnostic"]({
        threadId: thread.id,
        selection,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("GitError");
      expect(h.calls).toHaveLength(0);
    }),
  );
  it.effect("refuses missing PRs and orchestrators before making any gh call", () =>
    Effect.gen(function* () {
      const { boundPr: _, ...unbound } = thread;
      for (const current of [unbound, { ...thread, role: "orchestrator" as const }]) {
        const h = harness(current);
        const handlers = yield* h.handlers;
        const error = yield* handlers["git.prCheckDiagnostic"]({
          threadId: thread.id,
          selection,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("InvalidState");
        expect(h.calls).toHaveLength(0);
      }
    }),
  );
});

for (const includeLog of [false, true]) {
  for (const [change, current] of [
    ["repository rebind", { ...thread, boundPr: { repo: "other/app", number: 8, monitor: false } }],
    [
      "same-repository PR rebind",
      { ...thread, boundPr: { repo: "example/app", number: 8, monitor: false } },
    ],
    ["unbind onto the same branch PR", unboundThread],
    ["role change", { ...thread, role: "orchestrator" as const }],
    ["checkout move", { ...thread, checkout: { ...thread.checkout, path: dir + "/moved" } }],
    [
      "effective checkout override",
      { ...thread, currentCheckout: { kind: "worktree" as const, path: dir + "/followed" } },
    ],
    [
      "checkout branch change",
      { ...thread, checkout: { ...thread.checkout, branch: "different" } },
    ],
  ] as const)
    it.effect(`refuses mid-fetch ${change} (${includeLog ? "explicit log" : "annotations"})`, () =>
      Effect.gen(function* () {
        const h = harness(thread, {
          duringFetch: () => current,
          branchTarget: () => ({ repo: "example/app", number: 7 }),
        });
        const handlers = yield* h.handlers;
        const result = yield* Effect.result(
          handlers["git.prCheckDiagnostic"]({
            threadId: thread.id,
            selection: { ...selection, ...(includeLog ? { attempt: 2, includeLog: true } : {}) },
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(h.threadReads()).toBeGreaterThanOrEqual(2);
        expect(h.calls.filter((args) => args[1]?.endsWith("/logs"))).toHaveLength(
          includeLog ? 1 : 0,
        );
      }),
    );
}

it.effect("refuses a changed branch PR even when thread fields stay unchanged", () =>
  Effect.gen(function* () {
    const { boundPr: _, ...unbound } = thread;
    let branchTarget = { repo: "example/app", number: 7 };
    const h = harness(unbound, {
      branchTarget: () => branchTarget,
      duringFetch: () => {
        branchTarget = { repo: "example/app", number: 8 };
        return unbound;
      },
    });
    const handlers = yield* h.handlers;
    const result = yield* Effect.result(
      handlers["git.prCheckDiagnostic"]({ threadId: thread.id, selection }),
    );
    expect(result._tag).toBe("Failure");
  }),
);

it.effect("refuses a binding changed during the final unbound-target lookup", () =>
  Effect.gen(function* () {
    const { boundPr: _, ...unbound } = thread;
    const h = harness(unbound, {
      branchTarget: () => ({ repo: "example/app", number: 7 }),
      duringTargetLookup: () => ({
        ...thread,
        boundPr: { repo: "other/app", number: 8, monitor: false },
      }),
    });
    const handlers = yield* h.handlers;
    const result = yield* Effect.result(
      handlers["git.prCheckDiagnostic"]({ threadId: thread.id, selection }),
    );
    expect(result._tag).toBe("Failure");
    expect(h.threadReads()).toBe(3);
  }),
);

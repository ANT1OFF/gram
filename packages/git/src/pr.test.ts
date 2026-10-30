const REVIEW_BOT_FIXTURE = [
  { loginPattern: "example-code-review[bot]", rereviewCommand: "/agent review", canApprove: true },
];
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import type { ProcShape } from "./proc.ts";
import {
  boundPrStatus,
  buildPrDetail,
  buildPrStatus,
  actionsRunId,
  checkRuns,
  checksCounts,
  checkStatusOf,
  choosePr,
  commitList,
  conversation,
  GetPrStatus,
  isTip,
  makePrMemo,
  parsePrChecks,
  makePrResolver,
  parseOwnerRepo,
  PrLookupError,
  prLookupReason,
  prGraphqlQuery,
  rebaseDone,
  requiredRollupStatus,
  reshapePrNode,
  rollupStatus,
  withRequired,
  THREADS_MAX_AGE_MS,
  type PrInputs,
  type PrLookup,
} from "./pr.ts";
import { Proc } from "./proc.ts";

type Json = Record<string, unknown>;

const noAncestor = () => Effect.succeed(false);
const choose = (prs: Array<Json>, localTip: string, remoteTip = "") =>
  Effect.runSync(choosePr(prs, localTip, remoteTip, noAncestor));

/** A Proc where every git call fails (no ancestry) and `gh` is answered by `respond`. */
const mockProc = (respond: (args: ReadonlyArray<string>) => { status: number; stdout: string }) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const proc: ProcShape = {
    run: (bin, args) =>
      Effect.sync(() => {
        if (bin !== "gh") return { status: 1, stdout: "", stderr: "", truncated: false };
        calls.push(args);
        return { ...respond(args), stderr: "", truncated: false };
      }),
  };
  return { proc, calls };
};

const inputs = (branch: string): PrInputs => ({
  workTree: "/tmp",
  branch,
  localTip: `tip-${branch}`,
  remoteTip: "",
  repo: "acme/web",
});

/** An open PR node whose head commit's rollup is `nodes`. */
const openPrWith = (nodes: ReadonlyArray<Json>) =>
  reshapePrNode({
    number: 5,
    state: "OPEN",
    headRefOid: "deadbeef",
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
  });

const variables = (args: ReadonlyArray<string>) =>
  Object.fromEntries(
    args.filter((a) => /^[onbp]\d+=/.test(a)).map((a) => a.split("=") as [string, string]),
  );

describe("check rollups", () => {
  it("is none when empty and passing when all succeeded", () => {
    expect(rollupStatus(null)).toBe("none");
    expect(rollupStatus([])).toBe("none");
    expect(
      rollupStatus([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { state: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toBe("passing");
  });

  it("fails over pending, and pending over passing", () => {
    expect(
      rollupStatus([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]),
    ).toBe("failing");
    expect(rollupStatus([{ state: "ERROR" }])).toBe("failing");
    expect(
      rollupStatus([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "QUEUED" }]),
    ).toBe("pending");
    expect(rollupStatus([{ state: "PENDING" }])).toBe("pending");
  });

  it("treats cancelled and stale as neutral, not failing", () => {
    expect(checkStatusOf({ status: "COMPLETED", conclusion: "CANCELLED" })).toBe("neutral");
    expect(checkStatusOf({ status: "COMPLETED", conclusion: "STALE" })).toBe("neutral");
    const r = [
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "COMPLETED", conclusion: "CANCELLED" },
      { status: "COMPLETED", conclusion: "STALE" },
    ];
    expect(rollupStatus(r)).toBe("passing");
    expect(checksCounts(r)).toEqual({ passed: 3, total: 3 });
    expect(
      rollupStatus([{ status: "COMPLETED", conclusion: "CANCELLED" }, { status: "IN_PROGRESS" }]),
    ).toBe("pending");
    for (const conclusion of ["TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) {
      expect(rollupStatus([{ status: "COMPLETED", conclusion }])).toBe("failing");
    }
  });

  it("rolls up the required checks, or says nothing when none is marked required", () => {
    const macos = { status: "COMPLETED", conclusion: "SUCCESS", isRequired: true };
    const windows = { status: "COMPLETED", conclusion: "FAILURE", isRequired: false };
    expect(rollupStatus([macos, windows])).toBe("failing");
    expect(requiredRollupStatus([macos, windows])).toBe("passing");
    expect(requiredRollupStatus([macos, { status: "IN_PROGRESS", isRequired: false }])).toBe(
      "passing",
    );
    expect(requiredRollupStatus([{ ...macos, conclusion: "FAILURE" }, windows])).toBe("failing");
    // REST, or GitHub unable to say: every check counts, as before.
    expect(requiredRollupStatus([{ ...windows, isRequired: undefined }])).toBeUndefined();
    expect(requiredRollupStatus([windows])).toBeUndefined();
    expect(requiredRollupStatus(null)).toBeUndefined();
  });

  it("marks each check required or not, only when some check is", () => {
    const rows = [
      { name: "CI Gate", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
      { name: "check (windows)", status: "COMPLETED", conclusion: "FAILURE", isRequired: false },
    ];
    expect(checkRuns(rows).map((run) => run.required)).toEqual([true, false]);
    expect(checkRuns([rows[1]]).map((run) => run.required)).toEqual([undefined]);
    const view = rows.map((row) => ({ ...row, isRequired: undefined }));
    expect(checkRuns(withRequired(view, checkRuns(rows))).map((run) => run.required)).toEqual([
      true,
      false,
    ]);
    expect(withRequired(view, [])).toBe(view);
    // A check the lookup didn't see is left unmarked, not called optional.
    const added = [...view, { name: "new gate", status: "COMPLETED", conclusion: "FAILURE" }];
    expect(checkRuns(withRequired(added, checkRuns(rows))).map((run) => run.required)).toEqual([
      true,
      false,
      undefined,
    ]);
  });

  it("counts and normalises check rows", () => {
    expect(checksCounts(null)).toEqual({ passed: 0, total: 0 });
    expect(
      checksCounts([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { state: "SUCCESS" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "IN_PROGRESS" },
      ]),
    ).toEqual({ passed: 3, total: 5 });
    expect(
      checkRuns([
        { name: "build", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u1" },
        { context: "ci/lint", state: "FAILURE", targetUrl: "u2" },
      ]),
    ).toEqual([
      { name: "build", status: "passing", link: "u1", phase: "completed", conclusion: "SUCCESS" },
      { name: "ci/lint", status: "failing", link: "u2", phase: "completed" },
    ]);
  });

  it("reads each check's Actions run, phase, conclusion and timings", () => {
    const run = "https://github.com/acme/web/actions/runs/4242/job/7";
    expect(
      checkRuns([
        {
          name: "test",
          status: "COMPLETED",
          conclusion: "CANCELLED",
          detailsUrl: run,
          startedAt: "2026-09-16T10:00:00Z",
          completedAt: "2026-09-16T10:00:20Z",
        },
        { name: "e2e", status: "IN_PROGRESS", detailsUrl: run, startedAt: "2026-09-16T10:01:00Z" },
        { name: "deploy", status: "QUEUED", detailsUrl: run },
        { context: "ci/external", state: "PENDING", targetUrl: "https://ci.example/1" },
      ]),
    ).toEqual([
      {
        name: "test",
        status: "neutral",
        link: run,
        phase: "completed",
        runId: "4242",
        conclusion: "CANCELLED",
        startedAt: "2026-09-16T10:00:00Z",
        completedAt: "2026-09-16T10:00:20Z",
      },
      {
        name: "e2e",
        status: "pending",
        link: run,
        phase: "running",
        runId: "4242",
        startedAt: "2026-09-16T10:01:00Z",
      },
      { name: "deploy", status: "pending", link: run, phase: "queued", runId: "4242" },
      { name: "ci/external", status: "pending", link: "https://ci.example/1", phase: "queued" },
    ]);
    expect(actionsRunId("https://ci.example/1")).toBeUndefined();
  });
});

const statusFor = (state: "OPEN" | "MERGED" | "CLOSED", headRefOid: string) => ({
  number: 1,
  state,
  url: "",
  title: "",
  isDraft: false,
  checks: "none" as const,
  headMatches: true,
  aheadOfPr: false,
  headRefOid,
});

describe("SHA anchoring", () => {
  it("lets only a tip match yield merged", () => {
    const chosen = choose(
      [
        { number: 2, state: "OPEN", headRefOid: "bbb" },
        { number: 1, state: "MERGED", headRefOid: "aaa" },
      ],
      "aaa",
    );
    expect(chosen?.pr["number"]).toBe(1);
    expect([chosen?.headMatches, chosen?.aheadOfPr]).toEqual([true, false]);
  });

  it("counts the pushed tip as a match", () => {
    expect(
      choose([{ number: 5, state: "OPEN", headRefOid: "pushed" }], "localnew", "pushed")
        ?.headMatches,
    ).toBe(true);
  });

  it("never shows an unanchored merged or closed PR", () => {
    expect(choose([{ number: 1, state: "MERGED", headRefOid: "old" }], "new")).toBeUndefined();
    expect(
      choose([{ number: 322, state: "CLOSED", headRefOid: "9bf1cf13" }], "56f14ce9"),
    ).toBeUndefined();
    expect(choose([], "abc")).toBeUndefined();
  });

  it("marks an open PR ahead when its head is an ancestor, else shows it by name", () => {
    const ancestor = Effect.runSync(
      choosePr([{ number: 9, state: "OPEN", headRefOid: "old" }], "new", "", () =>
        Effect.succeed(true),
      ),
    );
    expect([ancestor?.headMatches, ancestor?.aheadOfPr]).toEqual([false, true]);
    const byName = choose([{ number: 7, state: "OPEN", headRefOid: "yyy" }], "local");
    expect([byName?.pr["number"], byName?.headMatches, byName?.aheadOfPr]).toEqual([
      7,
      false,
      false,
    ]);
  });

  it("guards empty oids", () => {
    expect(isTip("aaa", "aaa", "")).toBe(true);
    expect(isTip("bbb", "aaa", "bbb")).toBe(true);
    expect(isTip("", "", "")).toBe(false);
    expect(isTip("ccc", "aaa", "bbb")).toBe(false);
  });

  it("suppresses the rebase signal only on a terminal PR head", () => {
    expect(rebaseDone(statusFor("MERGED", "abc"), "abc")).toBe(true);
    expect(rebaseDone(statusFor("CLOSED", "abc"), "abc")).toBe(true);
    expect(rebaseDone(statusFor("MERGED", "abc"), "def")).toBe(false);
    expect(rebaseDone(statusFor("OPEN", "abc"), "abc")).toBe(false);
    expect(rebaseDone(undefined, "abc")).toBe(false);
    expect(rebaseDone(statusFor("MERGED", "abc"), "")).toBe(false);
  });
});

describe("GraphQL", () => {
  it("builds a well-formed batched document with variables", () => {
    for (const n of [1, 2, 5]) {
      const q = prGraphqlQuery(Array.from({ length: n }, () => ({ kind: "discover" as const })));
      expect(q.split("{").length).toBe(q.split("}").length);
      for (let i = 0; i < n; i++) {
        expect(q).toContain(`e${i}:repository(owner:$o${i},name:$n${i})`);
        expect(q).toContain(`headRefName:$b${i}`);
        expect(q).toContain(`$o${i}:String!`);
      }
      expect(q).not.toContain(`e${n}:`);
    }
  });

  it("packs branch and by-number lookups into one document", () => {
    const q = prGraphqlQuery([
      { kind: "discover" },
      { kind: "pr", fields: "badge" },
      { kind: "pr", fields: "review" },
      { kind: "pr", fields: "reviewAndThreads" },
    ]);
    expect(q.split("{").length).toBe(q.split("}").length);
    expect(q).toContain("$b0:String!");
    expect(q).toContain("$p1:Int!");
    expect(q).toContain("headRefName:$b0");
    expect(q).toContain("e1:repository(owner:$o1,name:$n1){pullRequest(number:$p1)");
    // A bound PR's badge shows no review-bot state, so its block never pays for those nodes; and
    // only the block that asks for threads carries them.
    expect(q.split("reviews(last:20)")).toHaveLength(3);
    expect(q.split("reviewThreads(first:50)")).toHaveLength(2);
    // Each block asks which checks its own PR requires.
    expect(q.split("isRequired(pullRequestNumber:$p1)")).toHaveLength(3);
    expect(q.split("isRequired(pullRequestNumber:$p3)")).toHaveLength(3);
  });

  it("lists a branch's candidates with nothing nested under them", () => {
    // GitHub prices a connection under these ten at ten requests: review threads here were five
    // of the six points a branch lookup cost.
    const q = prGraphqlQuery([{ kind: "discover" }]);
    expect(q).toContain("nodes{number state headRefOid}");
    expect(q).not.toContain("reviewThreads");
    expect(q).not.toContain("statusCheckRollup");
  });

  it("reshapes a node to the REST list shape", () => {
    const node = {
      number: 42,
      state: "OPEN",
      url: "https://github.com/o/r/pull/42",
      isDraft: false,
      headRefOid: "abc123",
      title: "Add thing",
      baseRefName: "main",
      baseRef: { target: { oid: "base999" } },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                    { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
                    { __typename: "StatusContext", state: "PENDING" },
                  ],
                },
              },
            },
          },
        ],
      },
    };
    const reshaped = reshapePrNode(node);
    for (const key of ["number", "state", "url", "isDraft", "headRefOid", "title", "baseRefName"]) {
      expect(reshaped[key]).toEqual((node as Json)[key]);
    }
    expect(reshaped["baseRefOid"]).toBe("base999");
    expect(reshapePrNode({ number: 1 })["baseRefOid"]).toBeNull();
    expect(reshaped["baseTipOid"]).toBe("base999");
    expect(rollupStatus(reshaped["statusCheckRollup"])).toBe("pending");
    expect(reshapePrNode({ number: 7, state: "MERGED" })["statusCheckRollup"]).toEqual([]);
  });

  it("keeps the base GitHub recorded for a PR apart from the base branch's tip", () => {
    const node = {
      baseRefOid: "recorded",
      baseRef: { target: { oid: "tip" } },
    };
    expect(reshapePrNode(node)["baseRefOid"]).toBe("recorded");
    expect(reshapePrNode(node)["baseTipOid"]).toBe("tip");
    // Every block asks for the tip, a bound PR's badge as much as a branch's: no connection, no cost.
    for (const fields of ["badge", "review", "reviewAndThreads"] as const)
      expect(prGraphqlQuery([{ kind: "pr", fields }])).toContain("baseRef{target{oid}}");
  });

  it.effect("carries required-check provenance even when all checks are green", () =>
    Effect.gen(function* () {
      const { proc } = mockProc(() => ({ status: 1, stdout: "" }));
      const anchored = { ...inputs("feature"), localTip: "deadbeef" };
      const gate = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
      const badge = (nodes: ReadonlyArray<Json>) =>
        buildPrStatus([openPrWith(nodes)], anchored).pipe(Effect.provideService(Proc, proc));
      const windowsRed = yield* badge([
        { ...gate, isRequired: true },
        { ...gate, conclusion: "FAILURE", isRequired: false },
      ]);
      expect(windowsRed).toMatchObject({ checks: "failing", requiredChecks: "passing" });
      const allGreen = yield* badge([
        { ...gate, isRequired: true },
        { ...gate, isRequired: false },
      ]);
      expect(allGreen?.checks).toBe("passing");
      expect(allGreen?.requiredChecks).toBe("passing");
    }),
  );

  it.effect("names who is asked to review on the badge, and which of them CODEOWNERS asked", () =>
    Effect.gen(function* () {
      const { proc } = mockProc(() => ({ status: 1, stdout: "" }));
      const anchored = { ...inputs("feature"), localTip: "deadbeef" };
      const node = reshapePrNode({
        number: 9,
        state: "OPEN",
        url: "u",
        headRefOid: "deadbeef",
        reviewDecision: "REVIEW_REQUIRED",
        reviewRequests: {
          nodes: [
            { asCodeOwner: true, requestedReviewer: { __typename: "Team", slug: "platform" } },
            { asCodeOwner: false, requestedReviewer: { __typename: "User", login: "mona" } },
            { asCodeOwner: false, requestedReviewer: null },
          ],
        },
      });
      const badge = yield* buildPrStatus([node], anchored).pipe(Effect.provideService(Proc, proc));
      expect(badge?.reviewRequests).toEqual([
        { kind: "team", name: "platform", codeOwner: true },
        { kind: "user", name: "mona" },
      ]);
      const none = yield* buildPrStatus(
        [reshapePrNode({ number: 9, state: "OPEN" })],
        anchored,
      ).pipe(Effect.provideService(Proc, proc));
      expect(none).not.toHaveProperty("reviewRequests");
      expect(prGraphqlQuery([{ kind: "pr", fields: "badge" }])).toContain(
        "reviewRequests(first:10)",
      );
      expect(prGraphqlQuery([{ kind: "discover" }])).not.toContain("reviewRequests");
    }),
  );

  it.effect("builds identical badges from REST and reshaped GraphQL lists", () =>
    Effect.gen(function* () {
      const { proc } = mockProc(() => ({ status: 1, stdout: "" }));
      const anchored = { ...inputs("feature"), localTip: "deadbeef" };
      const rest = [
        {
          number: 5,
          state: "MERGED",
          url: "u",
          isDraft: false,
          headRefOid: "deadbeef",
          title: "Done",
          baseRefName: "main",
          headRefName: "feature",
          author: { login: "mona" },
          additions: 24,
          deletions: 8,
          changedFiles: 1,
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        },
      ];
      const gql = [
        reshapePrNode({
          number: 5,
          state: "MERGED",
          url: "u",
          isDraft: false,
          headRefOid: "deadbeef",
          title: "Done",
          baseRefName: "main",
          headRefName: "feature",
          author: { login: "mona" },
          additions: 24,
          deletions: 8,
          changedFiles: 1,
          reviewDecision: "APPROVED",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        }),
      ];
      const fromRest = yield* buildPrStatus(rest, anchored).pipe(Effect.provideService(Proc, proc));
      const fromGql = yield* buildPrStatus(gql, anchored).pipe(Effect.provideService(Proc, proc));
      // The same badge, but for REST not having read the reviews.
      expect(fromGql).toEqual({ ...fromRest, reviewUnread: undefined });
      expect(fromRest).toMatchObject({ reviewUnread: true });
      expect(fromGql).toMatchObject({
        state: "MERGED",
        headMatches: true,
        checks: "passing",
        baseRef: "main",
        headRef: "feature",
        author: "mona",
        additions: 24,
        deletions: 8,
        changedFiles: 1,
        reviewDecision: "APPROVED",
      });
    }),
  );

  it.effect("batches many branches into one gh request per 40 and anchors each", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc((args) => {
        const vars = variables(args);
        const data: Json = {};
        for (const [key, branch] of Object.entries(vars)) {
          if (!key.startsWith("b")) continue;
          const i = key.slice(1);
          const nodes =
            branch === "reused"
              ? [{ number: 1, state: "MERGED", headRefOid: "old" }]
              : [{ number: Number(i) + 100, state: "MERGED", headRefOid: `tip-${branch}` }];
          data[`e${i}`] = { pullRequests: { nodes } };
        }
        for (const [key, number] of Object.entries(vars)) {
          if (!key.startsWith("p")) continue;
          data[`e${key.slice(1)}`] = {
            pullRequest: { number: Number(number), state: "MERGED", headRefOid: "any", url: "u" },
          };
        }
        return { status: 0, stdout: JSON.stringify({ data }) };
      });
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));
      const branches = [...Array.from({ length: 44 }, (_, i) => `b-${i}`), "reused"];
      const results = yield* Effect.forEach(
        branches,
        (branch) =>
          Effect.request(
            GetPrStatus({ lookup: { kind: "branch", inputs: inputs(branch) } }),
            resolver,
          ),
        {
          concurrency: "unbounded",
        },
      );
      // Two documents of candidates, and one more each for the PRs they resolved to.
      expect(calls.length).toBe(4);
      expect(results.slice(0, 44).every((p) => p?.state === "MERGED" && p.headMatches)).toBe(true);
      expect(results[44]).toBeUndefined();
    }),
  );

  it.effect(
    "falls back to REST on a data-less body, and fails the batch when gh itself fails",
    () =>
      Effect.gen(function* () {
        const rest = mockProc((args) =>
          args[0] === "api"
            ? { status: 0, stdout: JSON.stringify({ errors: [{ message: "bad" }] }) }
            : {
                status: 0,
                stdout: JSON.stringify([{ number: 3, state: "OPEN", headRefOid: "tip-x" }]),
              },
        );
        const viaRest = yield* Effect.request(
          GetPrStatus({ lookup: { kind: "branch", inputs: inputs("x") } }),
          makePrResolver(rest.proc),
        );
        expect(viaRest?.number).toBe(3);
        expect(rest.calls.map((c) => c[0])).toEqual(["api", "pr"]);

        const offline = mockProc(() => ({ status: 1, stdout: "" }));
        const error = yield* Effect.flip(
          Effect.request(
            GetPrStatus({ lookup: { kind: "branch", inputs: inputs("x") } }),
            makePrResolver(offline.proc),
          ),
        );
        expect(error).toBeInstanceOf(PrLookupError);
        expect(offline.calls.length).toBe(1);
      }),
  );
});

/** A `gh` over a table of PRs: `b<i>` lists a branch's candidates, `p<i>` takes one by number. */
const fakeGitHub = (prs: Array<Json & { number: number; headRefName: string }>) =>
  mockProc((args) => {
    const data: Json = {};
    for (const [key, value] of Object.entries(variables(args))) {
      const i = key.slice(1);
      if (key.startsWith("b")) {
        const nodes = prs
          .filter((pr) => pr.headRefName === value)
          .map(({ number, state, headRefOid }) => ({ number, state, headRefOid }));
        data[`e${i}`] = { pullRequests: { nodes } };
      } else if (key.startsWith("p")) {
        data[`e${i}`] = { pullRequest: prs.find((pr) => pr.number === Number(value)) ?? null };
      }
    }
    return { status: 0, stdout: JSON.stringify({ data }) };
  });

const botThread = (isResolved: boolean) => ({
  isResolved,
  isOutdated: false,
  comments: { nodes: [{ author: { login: "example-code-review", __typename: "Bot" }, body: "x" }] },
});

const queryOf = (args: ReadonlyArray<string>) =>
  args.find((a) => a.startsWith("query="))?.slice("query=".length) ?? "";

const openPr = (overrides: Json = {}) => ({
  number: 7,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/7",
  headRefName: "feat",
  headRefOid: "tip-feat",
  updatedAt: "2026-09-21T10:00:00Z",
  reviewThreads: { nodes: [botThread(false)] },
  ...overrides,
});

const lookupFeat = (resolver: ReturnType<typeof makePrResolver>) =>
  Effect.request(GetPrStatus({ lookup: { kind: "branch", inputs: inputs("feat") } }), resolver);

describe("a branch's PR, polled by number", () => {
  it.effect("costs one document once known, and leaves the threads out of it", () =>
    Effect.gen(function* () {
      const { proc, calls } = fakeGitHub([openPr()]);
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));

      const first = yield* lookupFeat(resolver);
      expect(first).toMatchObject({ number: 7, headMatches: true });
      expect(first?.review?.threads.unresolved).toBe(1);
      expect(calls).toHaveLength(2);
      expect(queryOf(calls[1]!)).toContain("reviewThreads");

      const again = yield* lookupFeat(resolver);
      expect(again?.review?.threads.unresolved).toBe(1);
      expect(calls).toHaveLength(3);
      expect(variables(calls[2]!)).toMatchObject({ b0: "feat", p1: "7" });
      expect(queryOf(calls[2]!)).not.toContain("reviewThreads");
    }),
  );

  it.effect("reads the threads again when the PR moves, and when they have aged", () =>
    Effect.gen(function* () {
      const prs = [openPr()];
      const { proc, calls } = fakeGitHub(prs);
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));
      yield* lookupFeat(resolver);

      prs[0] = openPr({
        updatedAt: "2026-09-21T10:05:00Z",
        reviewThreads: { nodes: [botThread(false), botThread(false)] },
      });
      const moved = yield* lookupFeat(resolver);
      expect(moved?.review?.threads.unresolved).toBe(2);
      expect(calls).toHaveLength(4);
      expect(queryOf(calls[3]!)).toContain("reviewThreads");

      // Resolved on github.com, which needn't move `updatedAt`: unseen until the threads age out.
      prs[0] = { ...prs[0]!, reviewThreads: { nodes: [botThread(true), botThread(true)] } };
      expect((yield* lookupFeat(resolver))?.review?.threads.unresolved).toBe(2);
      yield* TestClock.adjust(Duration.millis(THREADS_MAX_AGE_MS));
      const aged = yield* lookupFeat(resolver);
      expect(aged?.review?.threads.unresolved).toBe(0);
      // Aged threads ride the sweep's own document: no follow-up.
      expect(calls).toHaveLength(6);
      expect(queryOf(calls[5]!)).toContain("reviewThreads");
    }),
  );

  it.effect("reads the threads again after a write cleared the memo", () =>
    Effect.gen(function* () {
      const prs = [openPr()];
      const { proc, calls } = fakeGitHub(prs);
      const memo = makePrMemo();
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE), memo);
      yield* lookupFeat(resolver);

      prs[0] = { ...prs[0]!, reviewThreads: { nodes: [botThread(true)] } };
      memo.clear();
      expect((yield* lookupFeat(resolver))?.review?.threads.unresolved).toBe(0);
      expect(calls).toHaveLength(3);
    }),
  );

  it.effect("follows the branch to a new PR, and drops one that is gone", () =>
    Effect.gen(function* () {
      const prs = [openPr({ state: "CLOSED", headRefOid: "old" })];
      const { proc, calls } = fakeGitHub(prs);
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));
      // A closed PR on another commit is a reused name, not this branch's PR.
      expect(yield* lookupFeat(resolver)).toBeUndefined();
      expect(calls).toHaveLength(1);

      prs.push(openPr({ number: 8, url: "https://github.com/acme/web/pull/8" }));
      expect((yield* lookupFeat(resolver))?.number).toBe(8);

      prs.length = 0;
      expect(yield* lookupFeat(resolver)).toBeUndefined();
      // Forgotten, so the next document is the candidates alone.
      yield* lookupFeat(resolver);
      expect(Object.keys(variables(calls.at(-1)!))).not.toContain("p1");
    }),
  );
});

const boundNode = (number: number) => ({
  number,
  state: "MERGED",
  url: `https://github.com/acme/lib/pull/${number}`,
  title: "Fix the flake",
  isDraft: false,
  headRefOid: "abc",
  baseRefName: "main",
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
            },
          },
        },
      },
    ],
  },
});

/** A `gh` answering the batched document: branches by name, bound PRs by number. */
const batchingProc = () =>
  mockProc((args) => {
    const vars = variables(args);
    const data: Json = {};
    for (const [key, value] of Object.entries(vars)) {
      const i = key.slice(1);
      if (key.startsWith("b")) {
        data[`e${i}`] = {
          pullRequests: { nodes: [{ number: 100, state: "MERGED", headRefOid: `tip-${value}` }] },
        };
      } else if (key.startsWith("p")) {
        data[`e${i}`] = { pullRequest: boundNode(Number(value)) };
      }
    }
    return { status: 0, stdout: JSON.stringify({ data }) };
  });

describe("boundPrStatus", () => {
  it.effect("takes the PR by number from the batched document, never anchored", () =>
    Effect.gen(function* () {
      const { proc, calls } = batchingProc();
      const status = yield* boundPrStatus("/work/app", { repo: "acme/lib", number: 42 }).pipe(
        Effect.provideService(Proc, proc),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(0, 2)).toEqual(["api", "graphql"]);
      expect(calls[0]).toEqual(
        expect.arrayContaining(["-f", "o0=acme", "-f", "n0=lib", "-F", "p0=42"]),
      );
      expect(status).toMatchObject({
        number: 42,
        state: "MERGED",
        title: "Fix the flake",
        checks: "passing",
        headMatches: false,
        aheadOfPr: false,
        baseRef: "main",
      });
      // Without a review monitor on it, its block doesn't ask for the reviews, and says so.
      expect(status?.review).toBeUndefined();
      expect(status?.reviewUnread).toBe(true);
      expect(queryOf(calls[0]!)).not.toContain("reviews(");
    }),
  );

  it.effect(
    "reads the reviews for a review monitor, carrying the threads as a branch's PR does",
    () =>
      Effect.gen(function* () {
        const prs = [
          {
            ...boundNode(42),
            state: "OPEN",
            headRefName: "fix",
            updatedAt: "2026-09-29T10:00:00Z",
            reviews: {
              nodes: [
                {
                  id: "PRR_1",
                  author: { login: "alice", __typename: "User" },
                  state: "APPROVED",
                  submittedAt: "2026-09-29T10:00:00Z",
                  commit: { oid: "abc" },
                  body: "",
                },
              ],
            },
            reviewThreads: { nodes: [botThread(false)] },
          },
        ];
        const { proc, calls } = fakeGitHub(prs);
        const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));
        const bound = { repo: "acme/lib", number: 42, reviews: true };
        const look = boundPrStatus("/work/app", bound, resolver).pipe(
          Effect.provideService(Proc, proc),
        );

        const first = yield* look;
        expect(first?.reviewUnread).toBeUndefined();
        expect(first?.review?.humanReviews).toMatchObject([{ id: "PRR_1", verdict: "approved" }]);
        expect(first?.review?.threads.unresolved).toBe(1);
        expect(calls).toHaveLength(1);
        expect(queryOf(calls[0]!)).toContain("reviewThreads");

        // Its threads are carried, so the next look reads the reviews alone, in one document.
        expect((yield* look)?.review?.threads.unresolved).toBe(1);
        expect(calls).toHaveLength(2);
        expect(queryOf(calls[1]!)).toContain("reviews(last:20)");
        expect(queryOf(calls[1]!)).not.toContain("reviewThreads");

        // Moved since: one more document, with the threads.
        prs[0] = { ...prs[0]!, updatedAt: "2026-09-29T10:05:00Z" };
        expect((yield* look)?.review?.threads.unresolved).toBe(1);
        expect(calls).toHaveLength(4);
        expect(queryOf(calls[3]!)).toContain("reviewThreads");
      }),
  );

  it.effect("shares one document with the branch badges at the sweep's concurrency", () =>
    Effect.gen(function* () {
      const { proc, calls } = batchingProc();
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));
      const lookups: ReadonlyArray<PrLookup> = [
        ...Array.from(
          { length: 6 },
          (_, i) => ({ kind: "branch", inputs: inputs(`b-${i}`) }) as const,
        ),
        ...Array.from(
          { length: 6 },
          (_, i) =>
            ({
              kind: "number",
              bound: { workTree: "/tmp", repo: "acme/lib", number: 500 + i },
            }) as const,
        ),
      ];
      const results = yield* Effect.forEach(
        lookups,
        (lookup) => Effect.request(GetPrStatus({ lookup }), resolver),
        { concurrency: 4 },
      );
      // Bounded concurrency caps a batch at the fibers in flight, so this is 3 documents, not 1 —
      // but never 12, and at least one of them carries branches and bound PRs together.
      expect(calls.length).toBeLessThan(lookups.length);
      expect(calls.every((args) => args[0] === "api" && args[1] === "graphql")).toBe(true);
      expect(
        calls.some(
          (args) => args.some((a) => /^b\d+=/.test(a)) && args.some((a) => /^p\d+=/.test(a)),
        ),
      ).toBe(true);
      expect(results.slice(6).map((pr) => pr?.number)).toEqual([500, 501, 502, 503, 504, 505]);
      expect(results.slice(0, 6).every((pr) => pr?.headMatches)).toBe(true);
    }),
  );

  it.effect("falls back to one gh pr view when the document comes back shapeless", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc((args) =>
        args[0] === "api"
          ? { status: 0, stdout: JSON.stringify({ errors: [{ message: "bad" }] }) }
          : { status: 0, stdout: JSON.stringify({ number: 42, state: "OPEN", url: "u" }) },
      );
      const status = yield* boundPrStatus("/work/app", { repo: "acme/lib", number: 42 }).pipe(
        Effect.provideService(Proc, proc),
      );
      expect(status?.number).toBe(42);
      expect(calls.map((c) => c[0])).toEqual(["api", "pr"]);
      expect(calls[1]).toEqual(expect.arrayContaining(["pr", "view", "42", "--repo", "acme/lib"]));
    }),
  );

  it.effect("refuses a malformed repo or number without calling gh", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc(() => ({ status: 0, stdout: "{}" }));
      for (const bound of [
        { repo: "not a repo", number: 42 },
        { repo: "acme/lib", number: 0 },
      ]) {
        expect(
          yield* boundPrStatus("/work/app", bound).pipe(Effect.provideService(Proc, proc)),
        ).toBeUndefined();
      }
      expect(calls).toEqual([]);
    }),
  );
});

describe("PR detail", () => {
  const view: Json = {
    number: 7,
    state: "OPEN",
    url: "u",
    title: "t",
    body: "b",
    isDraft: false,
    author: { login: "octocat" },
    baseRefName: "main",
    headRefName: "feat/x",
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    commits: [{ oid: "a", messageHeadline: "m", committedDate: "d", authors: [] }],
    reviews: [{ author: { login: "r" }, body: "lgtm", state: "APPROVED", submittedAt: "z" }],
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    reviewRequests: [
      { __typename: "User", login: "alice" },
      { __typename: "Team", name: "Platform", slug: "example/platform" },
      { __typename: "User", login: "" },
    ],
    latestReviews: [
      { author: { login: "r" }, state: "APPROVED", submittedAt: "z", body: "lgtm" },
      { author: {}, state: "COMMENTED", submittedAt: "y" },
    ],
    labels: [
      { id: "LA_1", name: "bug", color: "d73a4a", description: "Something isn't working" },
      { id: "LA_2", name: "" },
    ],
  };

  it("maps commits and merges the conversation chronologically", () => {
    expect(
      commitList({
        commits: [
          {
            oid: "abc123",
            messageHeadline: "Fix bug",
            committedDate: "2026-06-01T10:00:00Z",
            authors: [{ login: "octocat", name: "Mona" }],
          },
          {
            oid: "def456",
            messageHeadline: "Docs",
            committedDate: "2026-06-02T10:00:00Z",
            authors: [{ name: "No Login" }],
          },
        ],
      }).map((c) => c.author),
    ).toEqual(["octocat", "No Login"]);
    const conv = conversation({
      comments: [{ author: { login: "alice" }, body: "second", createdAt: "2026-06-02T00:00:00Z" }],
      reviews: [
        {
          author: { login: "bob" },
          body: "",
          state: "APPROVED",
          submittedAt: "2026-06-01T00:00:00Z",
        },
        {
          author: { login: "carol" },
          body: "",
          state: "COMMENTED",
          submittedAt: "2026-06-03T00:00:00Z",
        },
      ],
    });
    expect(conv.map((c) => [c.author, c.kind, c.state])).toEqual([
      ["bob", "review", "APPROVED"],
      ["alice", "comment", ""],
    ]);
  });

  it("locks the detail shape", () => {
    const files = [{ path: "a.rs", status: "modified" as const, added: 1, removed: 0, diff: "" }];
    expect(buildPrDetail(view, files, undefined)).toEqual({
      number: 7,
      state: "OPEN",
      url: "u",
      title: "t",
      body: "b",
      isDraft: false,
      author: "octocat",
      baseRefName: "main",
      headRefName: "feat/x",
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      commits: 1,
      reviewDecision: "APPROVED",
      reviews: 1,
      checks: "passing",
      checksPassed: 1,
      checksTotal: 1,
      checkRuns: [
        { name: "", status: "passing", link: "", phase: "completed", conclusion: "SUCCESS" },
      ],
      commitList: [{ oid: "a", headline: "m", author: "", at: "d" }],
      conversation: [{ kind: "review", author: "r", state: "APPROVED", body: "lgtm", at: "z" }],
      files,
      reviewRequests: [
        { kind: "user", name: "alice" },
        { kind: "team", name: "example/platform" },
      ],
      latestReviews: [{ author: "r", state: "APPROVED", at: "z" }],
      labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }],
    });
  });
});

describe("rate-limited lookups", () => {
  it("classifies the failure off the shared matcher, not its own", () => {
    const limited = new PrLookupError({ message: "GraphQL: API rate limit already exceeded" });
    expect(limited.rateLimit).toEqual({ kind: "primary" });
    expect(prLookupReason(limited.message)).toBe("rate limited");
    const secondary = new PrLookupError({
      message: "You have exceeded a secondary rate limit\nRetry-After: 90",
    });
    expect(secondary.rateLimit).toEqual({ kind: "secondary", retryAfterSeconds: 90 });
    expect(prLookupReason(secondary.message)).toBe("rate limited");
    // 429 never matched the old "rate limit" substring, so it read as an unknown gh failure.
    expect(prLookupReason("HTTP 429: Too Many Requests")).toBe("rate limited");
    expect(new PrLookupError({ message: "HTTP 404" }).rateLimit).toBeUndefined();
  });

  it.effect("fails a refused document instead of fanning it out into REST", () =>
    Effect.gen(function* () {
      const { proc, calls } = mockProc((args) =>
        args[0] === "api"
          ? {
              status: 1,
              stdout: JSON.stringify({
                data: null,
                errors: [{ message: "API rate limit exceeded for user ID 1." }],
              }),
            }
          : { status: 0, stdout: "[]" },
      );
      const resolver = makePrResolver(proc, Effect.succeed(REVIEW_BOT_FIXTURE));
      const error = yield* Effect.flip(
        Effect.forEach(
          ["a", "b", "c"],
          (branch) =>
            Effect.request(
              GetPrStatus({ lookup: { kind: "branch", inputs: inputs(branch) } }),
              resolver,
            ),
          { concurrency: "unbounded" },
        ),
      );
      expect(error.rateLimit).toEqual({ kind: "primary" });
      expect(calls.map((c) => c[0])).toEqual(["api"]);
    }),
  );
});

const checksBody = (pullRequest: unknown) => ({ data: { repository: { pullRequest } } });
const checksContexts = (nodes: ReadonlyArray<unknown>) => ({
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] },
});

describe("parsePrChecks", () => {
  it("names check runs and status contexts alike, with the run behind each", () => {
    expect(
      parsePrChecks(
        checksBody(
          checksContexts([
            {
              __typename: "CheckRun",
              name: "build",
              status: "COMPLETED",
              conclusion: "FAILURE",
              detailsUrl: "https://github.com/acme/web/actions/runs/77/job/1",
            },
            {
              __typename: "StatusContext",
              context: "ci/external",
              state: "PENDING",
              targetUrl: "u",
            },
          ]),
        ),
      ),
    ).toMatchObject([
      { name: "build", status: "failing", runId: "77", conclusion: "FAILURE" },
      { name: "ci/external", status: "pending", link: "u" },
    ]);
  });

  it("reads a PR without checks as none, and a missing PR as unknown", () => {
    expect(
      parsePrChecks(checksBody({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })),
    ).toEqual([]);
    expect(parsePrChecks(checksBody(null))).toBeUndefined();
    expect(parsePrChecks({ errors: [{ type: "RATE_LIMIT" }] })).toBeUndefined();
  });
});

describe("prLookupReason", () => {
  it("names rate limits, auth and network failures, else gh's first line", () => {
    expect(prLookupReason("HTTP 403: API rate limit exceeded for user ID 1.")).toBe("rate limited");
    expect(prLookupReason("To get started with GitHub CLI, please run:  gh auth login")).toBe(
      "not logged in to gh",
    );
    expect(prLookupReason("error connecting to api.github.com: dial tcp: i/o timeout")).toBe(
      "network unavailable",
    );
    expect(prLookupReason("GraphQL: Something broke\nmore detail")).toBe(
      "GraphQL: Something broke",
    );
    expect(prLookupReason("  ")).toBe("gh failed");
    expect(prLookupReason("x".repeat(120))).toHaveLength(80);
  });
});

describe("origin parsing", () => {
  it("accepts scp, https and ssh remotes", () => {
    expect(parseOwnerRepo("git@github.com:acme/web.git")).toBe("acme/web");
    expect(parseOwnerRepo("https://github.com/acme/web")).toBe("acme/web");
    expect(parseOwnerRepo("https://github.com/acme/web.git/\n")).toBe("acme/web");
    expect(parseOwnerRepo("ssh://git@github.com:22/acme/web.git")).toBe("acme/web");
    expect(parseOwnerRepo("/local/path/repo.git")).toBeUndefined();
  });
});

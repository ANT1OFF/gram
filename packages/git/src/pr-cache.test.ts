import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { makeTtlCache } from "./pr-cache.ts";
import { readCiDiagnostic } from "./ci-diagnostics.ts";
import { createPr } from "./pr-create.ts";
import { Pr, PR_INPUTS_REV_PARSE, type PrChecksOptions, prChecksStamp, PrLive } from "./pr.ts";
import { Proc, type ProcOutput, type ProcShape } from "./proc.ts";
import { ReviewBots } from "./review-bots.ts";
import { Tools } from "./tools.ts";

const ok = (stdout: string): ProcOutput => ({ status: 0, stdout, stderr: "", truncated: false });
const no: ProcOutput = { status: 1, stdout: "", stderr: "", truncated: false };

const INPUTS = PR_INPUTS_REV_PARSE.join(" ");
/** What `resolvePrInputs`' one `rev-parse` prints for a branch never pushed: it stops at `@{upstream}`. */
const unpushed = (top: string, head: string): ProcOutput => ({
  status: 128,
  stdout: `${top}\n${head}\n`,
  stderr: "fatal: no upstream configured for branch",
  truncated: false,
});

interface RepoProcOptions {
  readonly head: () => string;
  readonly gh: (args: ReadonlyArray<string>) => { status: number; stdout: string; stderr?: string };
}

/** A `git` that answers `resolvePrInputs` from a movable HEAD, and a `gh` the test controls. */
const repoProc = (options: RepoProcOptions) => {
  const calls: Array<{ readonly bin: string; readonly args: ReadonlyArray<string> }> = [];
  const proc: ProcShape = {
    run: (bin, args) =>
      Effect.sync(() => {
        calls.push({ bin, args });
        if (bin !== "git") return { stderr: "", truncated: false, ...options.gh(args) };
        const joined = args.join(" ");
        if (joined === INPUTS) return unpushed("/repo", options.head());
        if (joined === "rev-parse --abbrev-ref HEAD") return ok("feature");
        if (joined === "config --get remote.origin.url") return ok("git@github.com:acme/web.git");
        return no;
      }),
  };
  return { proc, calls, ghCalls: () => calls.filter((call) => call.bin === "gh") };
};

const tools = Layer.succeed(Tools, {
  present: () => Effect.succeed(true),
  ghReady: Effect.succeed(true),
  check: Effect.succeed({ git: true, gh: true, claude: true, ghAuthed: true }),
});

const prLayer = (proc: ProcShape) =>
  PrLive.pipe(
    Layer.provide(Layer.succeed(Proc, proc)),
    Layer.provide(tools),
    Layer.provide(ReviewBots.layer),
  );

/**
 * Answers every document this file's lookups send: block `e0` as the branch's candidates and as the
 * PR chosen from them, and `e1` as that PR riding along once the branch is known.
 */
const badgeDocument = (number: number) => {
  const pullRequest = { number, state: "OPEN", url: "u", headRefOid: "tip", title: "t" };
  return JSON.stringify({
    data: { e0: { pullRequests: { nodes: [pullRequest] }, pullRequest }, e1: { pullRequest } },
  });
};

describe("makeTtlCache", () => {
  it.effect("collapses callers that arrive while a key is in flight into one fetch", () =>
    Effect.gen(function* () {
      let started = 0;
      const cache = makeTtlCache<string, number, never, never>({
        key: (input) => input,
        fetch: () =>
          Effect.gen(function* () {
            started++;
            for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
            return 7;
          }),
      });
      const values = yield* Effect.all([cache.get("a"), cache.get("a"), cache.get("a")], {
        concurrency: "unbounded",
      });
      expect(values).toEqual([7, 7, 7]);
      expect(started).toBe(1);
    }),
  );

  it.effect("serves a warm key and refetches once the entry ages out", () =>
    Effect.gen(function* () {
      let calls = 0;
      const counted = (ttlMs: number) =>
        makeTtlCache<string, number, never, never>({
          key: (input) => input,
          fetch: () => Effect.sync(() => ++calls),
          ttlMs,
        });
      const warm = counted(60_000);
      expect([yield* warm.get("a"), yield* warm.get("a"), yield* warm.get("b")]).toEqual([1, 1, 2]);
      calls = 0;
      const cold = counted(0);
      expect([yield* cold.get("a"), yield* cold.get("a")]).toEqual([1, 2]);
    }),
  );

  it.effect("keeps one entry a key, which an input that can't reuse it replaces", () =>
    Effect.gen(function* () {
      let calls = 0;
      const cache = makeTtlCache<{ id: string; seen?: string }, number, never, never>({
        key: ({ id }) => id,
        fetch: () => Effect.sync(() => ++calls),
        ttlMs: 60_000,
        reusable: (input, cached) => input.seen === undefined || input.seen === cached.seen,
      });
      expect(yield* cache.get({ id: "a", seen: "x" })).toBe(1);
      expect(yield* cache.get({ id: "a", seen: "x" })).toBe(1);
      expect(yield* cache.get({ id: "a" })).toBe(1);
      expect(yield* cache.get({ id: "a", seen: "y" })).toBe(2);
      // The refused entry is gone, not kept beside the new one.
      expect(yield* cache.get({ id: "a" })).toBe(2);
      expect(yield* cache.get({ id: "a", seen: "x" })).toBe(3);
    }),
  );

  it.effect("doesn't join a fetch in flight for an input it couldn't reuse, nor let it win", () =>
    Effect.gen(function* () {
      const gates = new Map<string, Deferred.Deferred<void>>();
      const started: Array<string> = [];
      const cache = makeTtlCache<{ id: string; seen: string }, string, never, never>({
        key: ({ id }) => id,
        fetch: ({ seen }) =>
          Effect.gen(function* () {
            started.push(seen);
            const gate = Deferred.makeUnsafe<void>();
            gates.set(seen, gate);
            yield* Deferred.await(gate);
            return `read as ${seen}`;
          }),
        ttlMs: 60_000,
        reusable: (input, cached) => input.seen === cached.seen,
      });
      const old = yield* cache.get({ id: "a", seen: "passing" }).pipe(Effect.forkScoped);
      const joined = yield* cache.get({ id: "a", seen: "passing" }).pipe(Effect.forkScoped);
      const next = yield* cache.get({ id: "a", seen: "failing" }).pipe(Effect.forkScoped);
      for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
      expect(started).toEqual(["passing", "failing"]);

      // The newer answer lands first; the older fetch still answers its own callers, and only them.
      yield* Deferred.succeed(gates.get("failing")!, undefined);
      expect(yield* Fiber.join(next)).toBe("read as failing");
      yield* Deferred.succeed(gates.get("passing")!, undefined);
      expect(yield* Fiber.join(old)).toBe("read as passing");
      expect(yield* Fiber.join(joined)).toBe("read as passing");
      expect(yield* cache.get({ id: "a", seen: "failing" })).toBe("read as failing");
      expect(started).toEqual(["passing", "failing"]);
    }).pipe(Effect.scoped),
  );

  it.effect("never keeps a failure, and clears on demand", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const cache = makeTtlCache<string, number, string, never>({
        key: (input) => input,
        fetch: () =>
          Effect.suspend(() => (++attempts < 3 ? Effect.fail("nope") : Effect.succeed(attempts))),
        ttlMs: 60_000,
      });
      expect(yield* Effect.flip(cache.get("a"))).toBe("nope");
      expect(yield* Effect.flip(cache.get("a"))).toBe("nope");
      expect(yield* cache.get("a")).toBe(3);
      expect(yield* cache.get("a")).toBe(3);
      cache.clear();
      expect(yield* cache.get("a")).toBe(4);
    }),
  );

  it.effect("a fetch that began before a clear cannot write its answer back after it", () =>
    Effect.gen(function* () {
      let answer = "before";
      const cache = makeTtlCache<string, string, never, never>({
        key: (input) => input,
        fetch: () =>
          Effect.gen(function* () {
            const reading = answer;
            for (let i = 0; i < 5; i++) yield* Effect.yieldNow;
            return reading;
          }),
        ttlMs: 60_000,
      });
      const stale = yield* Effect.all(
        [
          cache.get("a"),
          Effect.sync(() => {
            // The write an `invalidatePrReviews()` stands for: the in-flight read is now obsolete.
            answer = "after";
            cache.clear();
            return "";
          }),
        ],
        { concurrency: "unbounded" },
      );
      expect(stale[0]).toBe("before");
      expect(yield* cache.get("a")).toBe("after");
    }),
  );
});

describe("Pr.status caching", () => {
  it.effect("answers repeat badge lookups from one gh spawn", () =>
    Effect.gen(function* () {
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: () => ({ status: 0, stdout: badgeDocument(11) }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const badges = yield* Effect.all([pr.status("/repo"), pr.status("/repo")], {
          concurrency: "unbounded",
        });
        expect(yield* pr.status("/repo")).toMatchObject({ number: 11 });
        expect(badges.map((badge) => badge?.number)).toEqual([11, 11]);
      }).pipe(Effect.provide(prLayer(proc)));
      // The branch's candidates, then the PR chosen from them: once, whoever asks.
      expect(ghCalls()).toHaveLength(2);
    }),
  );

  it.effect("fresh status bypasses a warm bound badge and old review memo", () =>
    Effect.gen(function* () {
      let failing = false;
      const { proc, ghCalls } = repoProc({
        head: () => "tip",
        gh: () => ({
          status: 0,
          stdout: JSON.stringify({
            data: {
              e0: {
                pullRequest: {
                  number: 11,
                  state: "OPEN",
                  url: "https://github.com/acme/web/pull/11",
                  headRefOid: "tip",
                  title: "t",
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            contexts: {
                              nodes: [
                                {
                                  __typename: "CheckRun",
                                  name: "check",
                                  status: "COMPLETED",
                                  conclusion: failing ? "FAILURE" : "SUCCESS",
                                },
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
          }),
        }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const bound = { repo: "acme/web", number: 11, reviews: true };
        expect(yield* pr.status("/repo", bound)).toMatchObject({ checks: "passing" });
        failing = true;
        expect(yield* pr.status("/repo", bound)).toMatchObject({ checks: "passing" });
        const before = ghCalls().length;
        expect(yield* pr.status("/repo", bound, undefined, { fresh: true })).toMatchObject({
          checks: "failing",
        });
        expect(ghCalls().length).toBeGreaterThan(before);
      }).pipe(Effect.provide(prLayer(proc)));
    }),
  );

  it.effect("a merge's read of the REST fallback has the tip, or no read at all", () =>
    Effect.gen(function* () {
      const recorded = "a".repeat(40);
      const tip = "c".repeat(40);
      const head = "d".repeat(40);
      let tipReadable = true;
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: (args) => {
          const joined = args.join(" ");
          // A document GitHub answered without usable data: the one PR is read over REST.
          if (joined.includes("query=") && !joined.includes("ref="))
            return { status: 0, stdout: "{}" };
          if (joined.includes("ref="))
            return {
              status: 0,
              stdout: JSON.stringify({ data: { repository: { object: null } } }),
            };
          if (joined.includes("commits/heads%2Fmain"))
            return tipReadable ? { status: 0, stdout: `${tip}\n` } : { status: 1, stdout: "" };
          return {
            status: 0,
            stdout: JSON.stringify({
              number: 11,
              state: "OPEN",
              url: "https://github.com/acme/web/pull/11",
              title: "t",
              headRefOid: head,
              baseRefOid: recorded,
              baseRefName: "main",
              headRefName: "feature",
              statusCheckRollup: [],
            }),
          };
        },
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const read = pr.status("/repo", { repo: "acme/web", number: 11 }, undefined, {
          forMerge: true,
          localCheckHead: head,
        });
        expect(yield* read).toMatchObject({ baseRefOid: recorded, baseTipOid: tip });
        // The policy comes from where the merge lands, not the base the PR last synced with.
        expect(ghCalls().some((call) => call.args.includes(`ref=${tip}:.gram/merge-ci.json`))).toBe(
          true,
        );
        tipReadable = false;
        expect((yield* Effect.flip(read)).message).toContain("tip of main");
      }).pipe(Effect.provide(prLayer(proc)));
    }),
  );

  it.effect("refetches when the checkout's HEAD moves", () =>
    Effect.gen(function* () {
      let head = "aaa";
      const { proc, ghCalls } = repoProc({
        head: () => head,
        gh: () => ({ status: 0, stdout: badgeDocument(11) }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        yield* pr.status("/repo");
        yield* pr.status("/repo");
        head = "bbb";
        yield* pr.status("/repo");
      }).pipe(Effect.provide(prLayer(proc)));
      // Two to find the PR, then one document for a branch whose PR is known.
      expect(ghCalls()).toHaveLength(3);
    }),
  );

  it.effect("does not cache a failed lookup", () =>
    Effect.gen(function* () {
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: () => ({ status: 1, stdout: "", stderr: "gh exploded" }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        expect(yield* Effect.flip(pr.status("/repo"))).toMatchObject({ _tag: "PrLookupError" });
        expect(yield* Effect.flip(pr.status("/repo"))).toMatchObject({ _tag: "PrLookupError" });
      }).pipe(Effect.provide(prLayer(proc)));
      expect(ghCalls()).toHaveLength(2);
    }),
  );

  it.effect('opening a PR drops the cached "no PR", though no tip moved', () =>
    Effect.gen(function* () {
      let opened = false;
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: (args) => {
          if (args[0] === "pr" && args[1] === "create") {
            opened = true;
            return { status: 0, stdout: "https://github.com/acme/web/pull/11\n" };
          }
          return {
            status: 0,
            stdout: opened
              ? badgeDocument(11)
              : JSON.stringify({ data: { e0: { pullRequests: { nodes: [] } } } }),
          };
        },
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        expect(yield* pr.status("/repo")).toBeUndefined();
        yield* createPr("/repo", { title: "t", body: "b", base: "main", draft: false }).pipe(
          Effect.provideService(Proc, proc),
        );
        expect(yield* pr.status("/repo")).toMatchObject({ number: 11 });
      }).pipe(Effect.provide(prLayer(proc)));
      expect(ghCalls()).toHaveLength(4);
    }),
  );

  it.effect("caches a bound PR badge per repo and number", () =>
    Effect.gen(function* () {
      const bound = {
        data: { e0: { pullRequest: { number: 42, state: "OPEN", url: "u", title: "t" } } },
      };
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: () => ({ status: 0, stdout: JSON.stringify(bound) }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const ref = { repo: "acme/lib", number: 42 };
        expect(yield* pr.status("/repo", ref)).toMatchObject({ number: 42 });
        expect(yield* pr.status("/repo", ref)).toMatchObject({ number: 42 });
        expect(yield* pr.status("/other", ref)).toMatchObject({ number: 42 });
      }).pipe(Effect.provide(prLayer(proc)));
      expect(ghCalls()).toHaveLength(1);
    }),
  );

  it.effect("reads a PR's checks in one small request, shared by everyone on the PR", () =>
    Effect.gen(function* () {
      const node = {
        __typename: "CheckRun",
        name: "build",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/acme/lib/actions/runs/77/job/1",
      };
      const commits = {
        nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [node] } } } }],
      };
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: () => ({
          status: 0,
          stdout: JSON.stringify({ data: { repository: { pullRequest: { commits } } } }),
        }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const [one, other] = yield* Effect.all(
          [pr.checks("/repo", 42, "acme/lib"), pr.checks("/other", 42, "Acme/Lib")],
          { concurrency: "unbounded" },
        );
        expect(one).toMatchObject([{ name: "build", status: "failing", runId: "77" }]);
        expect(other).toEqual(one);
        // Without a repo named, the checkout's own origin.
        yield* pr.checks("/repo", 7);
      }).pipe(Effect.provide(prLayer(proc)));
      expect(ghCalls()).toHaveLength(2);
      expect(ghCalls()[0]?.args).toEqual(
        expect.arrayContaining(["api", "graphql", "o=acme", "n=lib", "p=42"]),
      );
      expect(ghCalls()[1]?.args).toEqual(expect.arrayContaining(["o=acme", "n=web", "p=7"]));
    }),
  );

  it.effect("never answers a stamped or fresh checks lookup from before the PR changed", () =>
    Effect.gen(function* () {
      let conclusion = "SUCCESS";
      const body = () => {
        const node = { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion };
        const commits = {
          nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [node] } } } }],
        };
        return JSON.stringify({ data: { repository: { pullRequest: { commits } } } });
      };
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: () => ({ status: 0, stdout: body() }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const read = (options?: PrChecksOptions) =>
          pr.checks("/repo", 42, "acme/lib", options).pipe(Effect.map((runs) => runs[0]?.status));
        const passing = prChecksStamp({ headRefOid: "aaa", checks: "passing" });
        const failing = prChecksStamp({ headRefOid: "aaa", checks: "failing" });
        expect(yield* read({ stamp: passing })).toBe("passing");
        conclusion = "FAILURE";
        // Within the TTL the same stamp is a warm hit, and so is a caller that names none.
        expect(yield* read({ stamp: passing })).toBe("passing");
        expect(yield* read()).toBe("passing");
        expect(ghCalls()).toHaveLength(1);
        expect(yield* read({ stamp: failing })).toBe("failing");
        expect(ghCalls()).toHaveLength(2);
        // One entry a PR: everyone who knows it failed, or names no state, shares that read.
        expect(yield* read({ stamp: failing })).toBe("failing");
        expect(yield* read()).toBe("failing");
        expect(ghCalls()).toHaveLength(2);

        conclusion = "SUCCESS";
        expect(yield* read({ stamp: failing, fresh: true })).toBe("passing");
        expect(ghCalls()).toHaveLength(3);
        // The last read, with the stamp it was asked under, for a reader that asks nothing.
        expect(yield* pr.seenChecks("Acme/Lib", 42)).toMatchObject({
          checks: [{ name: "build", status: "passing" }],
          stamp: failing,
        });
        expect(yield* pr.seenChecks("acme/lib", 43)).toBeUndefined();
        expect(ghCalls()).toHaveLength(3);
      }).pipe(Effect.provide(prLayer(proc)));
    }),
  );

  it.effect("doesn't take an answer read under no stamp for one the caller has a stamp for", () =>
    Effect.gen(function* () {
      const commits = { nodes: [{ commit: { statusCheckRollup: null } }] };
      const { proc, ghCalls } = repoProc({
        head: () => "aaa",
        gh: () => ({
          status: 0,
          stdout: JSON.stringify({ data: { repository: { pullRequest: { commits } } } }),
        }),
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        yield* pr.checks("/repo", 42, "acme/lib");
        yield* pr.checks("/repo", 42, "acme/lib", { stamp: "aaa:failing" });
      }).pipe(Effect.provide(prLayer(proc)));
      expect(ghCalls()).toHaveLength(2);
    }),
  );

  it.effect("primes a whole sweep's lookups in one document, which `status` then reads", () =>
    Effect.gen(function* () {
      const gh: Array<ReadonlyArray<string>> = [];
      let branchReads = 0;
      const proc: ProcShape = {
        run: (bin, args, options) =>
          Effect.sync(() => {
            const joined = args.join(" ");
            if (bin === "git") {
              if (joined === "rev-parse --abbrev-ref HEAD") branchReads++;
              // By the checkout's name: on Windows the work tree comes back as `\wt1`.
              const name = options.cwd.split(/[\\/]/).at(-1);
              if (joined === INPUTS) return unpushed(options.cwd, `tip/${name}`);
              if (joined === "rev-parse --abbrev-ref HEAD") return ok(`feat/${name}`);
              if (joined === "config --get remote.origin.url")
                return ok("git@github.com:acme/web.git");
              return no;
            }
            gh.push(args);
            const data: Record<string, unknown> = {};
            for (const arg of args) {
              const match = /^([bp])(\d+)=(.*)$/.exec(arg);
              if (match === null) continue;
              const [, kind, i, value] = match;
              const number = kind === "b" ? Number(value!.replace(/\D/g, "")) : Number(value);
              const pullRequest = {
                number,
                state: "OPEN",
                url: "u",
                headRefOid: `tip/wt${number}`,
              };
              data[`e${i}`] =
                kind === "b" ? { pullRequests: { nodes: [pullRequest] } } : { pullRequest };
            }
            return ok(JSON.stringify({ data }));
          }),
      };
      const checkouts = ["/wt1", "/wt2", "/wt3"];
      const bound = { repo: "acme/lib", number: 42 };
      const lookups = [...checkouts.map((cwd) => ({ cwd })), { cwd: "/wt1", bound }];

      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const sweep = Effect.gen(function* () {
          branchReads = 0;
          yield* pr.prime(lookups);
          const primed = gh.length;
          // As the sweep asks: one checkout after another, each after its own git work.
          for (const cwd of checkouts) {
            const read = { branch: `feat${cwd}`, head: `tip${cwd}` };
            expect(yield* pr.status(cwd, undefined, read)).toBeDefined();
          }
          expect(yield* pr.status("/wt1", bound)).toMatchObject({ number: 42 });
          expect(gh.length).toBe(primed);
          // Each checkout's branch was read once, by the prime: `status` took what it read.
          expect(branchReads).toBe(checkouts.length);
        });

        // The first sweep finds each branch's PR, which is a second document.
        yield* sweep;
        expect(gh).toHaveLength(2);

        yield* TestClock.adjust(Duration.seconds(15));
        yield* sweep;
        expect(gh).toHaveLength(3);
        const vars = gh[2]!.filter((arg) => /^[bp]\d+=/.test(arg));
        expect(vars.filter((arg) => arg.startsWith("b"))).toHaveLength(3);
        // Each branch's known PR, and the bound one.
        expect(vars.filter((arg) => arg.startsWith("p"))).toHaveLength(4);

        // Taken once: a later `status` reads the branch again rather than trust the prime's.
        branchReads = 0;
        yield* pr.status("/wt1", undefined, { branch: "feat/wt1", head: "tip/wt1" });
        expect(branchReads).toBe(1);

        // Nor is a prime taken for a checkout that has since moved to another branch or commit.
        yield* pr.prime([{ cwd: "/wt1" }, { cwd: "/wt2" }]);
        branchReads = 0;
        yield* pr.status("/wt1", undefined, { branch: "other", head: "tip/wt1" });
        yield* pr.status("/wt2", undefined, { branch: "feat/wt2", head: "moved" });
        expect(branchReads).toBe(2);
      }).pipe(Effect.provide(prLayer(proc)));
    }),
  );
});

it.effect(
  "CI diagnostic evidence bypasses but does not populate or invalidate the existing checks cache",
  () =>
    Effect.gen(function* () {
      const head = "a".repeat(40);
      let graphqlCalls = 0;
      const { proc } = repoProc({
        head: () => head,
        gh: (args) => {
          const path = args[1];
          let body: unknown;
          if (path === "graphql") {
            graphqlCalls++;
            body = {
              data: {
                repository: {
                  pullRequest: {
                    commits: {
                      nodes: [
                        {
                          commit: {
                            statusCheckRollup: {
                              contexts: {
                                nodes: [
                                  { name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
                                ],
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            };
          } else if (args[0] === "pr")
            body = {
              headRefOid: head,
              statusCheckRollup: [
                { detailsUrl: "https://github.com/acme/lib/actions/runs/12/job/34" },
              ],
            };
          else if (path === "repos/acme/lib/actions/runs/12")
            body = { id: 12, head_sha: head, run_attempt: 2 };
          else if (path === "repos/acme/lib/actions/runs/12/attempts/2/jobs?per_page=100")
            body = {
              total_count: 1,
              jobs: [
                {
                  id: 34,
                  run_id: 12,
                  head_sha: head,
                  name: "check",
                  status: "completed",
                  conclusion: "failure",
                },
              ],
            };
          else throw new Error("Unexpected synthetic command");
          return { status: 0, stdout: JSON.stringify(body) };
        },
      });
      yield* Effect.gen(function* () {
        const pr = yield* Pr;
        const stamp = prChecksStamp({ headRefOid: head, checks: "passing" });
        const warm = yield* pr.checks("/repo", 42, "acme/lib", { stamp });
        const seen = yield* pr.seenChecks("acme/lib", 42);
        const evidence = yield* readCiDiagnostic("/repo", "acme/lib", 42, {
          repo: "acme/lib",
          number: 42,
          headOid: head,
          runId: "12",
          jobId: "34",
        }).pipe(Effect.provideService(Proc, proc));
        expect(evidence.conclusion).toBe("failure");
        expect(yield* pr.checks("/repo", 42, "acme/lib", { stamp })).toEqual(warm);
        expect(yield* pr.seenChecks("acme/lib", 42)).toEqual(seen);
        expect(graphqlCalls).toBe(1);
      }).pipe(Effect.provide(prLayer(proc)));
    }),
);

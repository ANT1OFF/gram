import { afterAll, describe, expect, it } from "@effect/vitest";
import type { GitState, PrStatus } from "@gram/contracts";
import {
  applySuggestion,
  Pr,
  type PrCheck,
  type PrDetailResponse,
  PrLookupError,
  ReviewActionError,
  type SeenChecks,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { EventHub } from "../events/event-hub.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { gitHandlers } from "../rpc/handlers/git.ts";
import { makeRuntimeTestLayer, waitFor } from "../runtime/test-harness.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { gitPlatformTest } from "./platform.ts";
import { GitStatePublisher, GitStatePublisherLive } from "./publisher.ts";
import { PrReviews } from "./review.ts";
import { hasGit, makeRepo, removeDir, tempDir } from "./test-repo.ts";

const RUNS = "https://github.com/acme/web/actions/runs";
const reruns: Array<ReadonlyArray<string>> = [];
let checkRuns: Array<PrCheck> = [];
const checksAsked: Array<ReadonlyArray<unknown>> = [];
let checksFail: PrLookupError | undefined;
let badge: PrStatus | undefined;

const detail = (): NonNullable<PrDetailResponse["detail"]> => ({
  number: 12,
  state: "OPEN",
  url: "https://github.com/acme/web/pull/12",
  title: "Retry",
  body: "",
  isDraft: false,
  author: "me",
  baseRefName: "main",
  headRefName: "fix/retry",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  commits: 1,
  reviewDecision: "",
  reviews: 0,
  checks: "failing",
  checksPassed: 0,
  checksTotal: checkRuns.length,
  checkRuns,
  commitList: [],
  conversation: [],
  files: [],
  reviewRequests: [],
  latestReviews: [],
  labels: [],
});

/** The last answer `checks` gave, as `Pr.seenChecks` keeps it. */
let seen: SeenChecks | undefined;

const FakePr = Layer.succeed(Pr, {
  status: () => Effect.sync(() => badge),
  checks: (cwd, number, repo, options) =>
    Effect.suspend(() => {
      checksAsked.push([cwd, number, repo, options]);
      if (checksFail !== undefined) return Effect.fail(checksFail);
      seen = { checks: checkRuns, stamp: options?.stamp, at: Date.now() };
      return Effect.succeed(checkRuns);
    }),
  prime: () => Effect.void,
  seenChecks: () => Effect.sync(() => seen),
  detail: () => Effect.sync(() => ({ available: true, detail: detail() })),
});

const offline = () => Effect.fail(new ReviewActionError({ message: "no network in tests" }));

const FakeReviews = Layer.succeed(PrReviews, {
  fetch: offline,
  reply: offline,
  resolve: offline,
  comment: offline,
  applySuggestion,
  rerun: (workTree, repo, runId) =>
    runId === "13"
      ? Effect.fail(new ReviewActionError({ message: "run 13 is still in progress" }))
      : Effect.sync(() => void reruns.push([workTree, repo, runId])),
  isPushed: () => Effect.succeed(undefined),
});

const TestLayer = GitStatePublisherLive.pipe(
  Layer.provideMerge(makeRuntimeTestLayer()),
  Layer.provideMerge(gitPlatformTest({ pr: FakePr, prReviews: FakeReviews })),
);

const check = (name: string, status: PrCheck["status"], extra: Partial<PrCheck> = {}): PrCheck => ({
  name,
  status,
  link: "",
  phase: "completed",
  ...extra,
});

describe.skipIf(!hasGit)("git.prChecks and git.prRerunChecks", () => {
  const dirs: Array<string> = [];
  afterAll(() => {
    for (const dir of dirs) removeDir(dir);
  });

  const setup = Effect.gen(function* () {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: repo,
      checkout: { kind: "main", path: repo },
    });
    return { repo, thread, handlers: yield* gitHandlers, runtimes };
  });

  it.live("answers the PR's checks from the checks lookup, and none without a PR", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      const checks = handlers["git.prChecks"]({ threadId: thread.id });
      checksAsked.length = 0;
      expect(yield* checks).toEqual({ checks: [] });
      expect(checksAsked).toEqual([]);

      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));
      checkRuns = [
        check("lint", "passing", { runId: "9", link: `${RUNS}/9/job/1`, conclusion: "SUCCESS" }),
        check("ci/external", "pending", { phase: "queued" }),
      ];
      expect(yield* checks).toEqual({ checks: checkRuns });
      // No badge has been published for this checkout, so there is no stamp to key the answer by.
      expect(checksAsked).toEqual([[repo, 12, "acme/web", { stamp: undefined }]]);

      // Once the badge is known its head and rollup key the answer, so one from before CI changed
      // is never reused.
      badge = {
        number: 12,
        state: "OPEN",
        url: "https://github.com/acme/web/pull/12",
        title: "Retry",
        isDraft: false,
        checks: "failing",
        headMatches: true,
        aheadOfPr: false,
        headRefOid: "abc123",
      };
      yield* (yield* GitStatePublisher).refresh(repo, { remote: true });
      checksAsked.length = 0;
      checkRuns = [...checkRuns, check("build", "failing")];
      const sent: Array<GitState> = [];
      yield* (yield* EventHub)
        .serverEvents(Effect.succeed({ type: "threads.snapshot", threads: [] }))
        .pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              if (event.type === "git.state" && event.threadId === thread.id)
                sent.push(event.state);
            }),
          ),
          Effect.forkScoped,
        );
      // The subscription is made on the forked fiber's first run.
      yield* Effect.sleep("20 millis");
      yield* checks;
      yield* waitFor(
        "the named state",
        Effect.sync(() => sent.at(-1)?.pr?.failingChecks !== undefined),
      );
      expect(checksAsked).toEqual([[repo, 12, "acme/web", { stamp: "abc123:failing" }]]);
      // A PR failing since before the app opened has no CI notice to name its checks: the strip's
      // read does, though the state didn't otherwise change.
      const shown = yield* (yield* GitStatePublisher).stateForThread(
        yield* (yield* ThreadStore).getThread(thread.id),
      );
      expect(shown?.pr?.failingChecks?.names).toEqual(["build"]);

      // Numbers are local to a repository: another repository's #12 says nothing of this one.
      badge = { ...badge, url: "https://github.com/acme/api/pull/12", checks: "passing" };
      yield* (yield* GitStatePublisher).refresh(repo, { remote: true });
      checksAsked.length = 0;
      yield* checks;
      expect(checksAsked).toEqual([[repo, 12, "acme/web", { stamp: undefined }]]);

      checksFail = new PrLookupError({ message: "API rate limit exceeded" });
      expect(yield* checks.pipe(Effect.flip)).toMatchObject({
        _tag: "GitError",
        message: "API rate limit exceeded",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          checksFail = undefined;
          badge = undefined;
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.live("reruns each failed or cancelled Actions run once and reports other providers", () =>
    Effect.gen(function* () {
      const { repo, thread, handlers, runtimes } = yield* setup;
      const rerun = handlers["git.prRerunChecks"]({ threadId: thread.id });
      expect(yield* rerun.pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidState",
        message: "This thread has no pull request",
      });

      yield* runtimes.updateThread(thread.id, (t) => ({
        ...t,
        boundPr: { repo: "acme/web", number: 12, monitor: false },
      }));
      checkRuns = [
        check("lint", "passing", { runId: "9", link: `${RUNS}/9/job/1` }),
        check("test (linux)", "failing", { runId: "7", link: `${RUNS}/7/job/2` }),
        check("test (windows)", "failing", { runId: "7", link: `${RUNS}/7/job/3` }),
        check("e2e", "neutral", { runId: "8", conclusion: "CANCELLED" }),
        check("ci/external", "failing", { link: "https://ci.example/1" }),
      ];
      reruns.length = 0;
      checksAsked.length = 0;
      expect(yield* rerun).toEqual({ runIds: ["7", "8"], skipped: ["ci/external"] });
      // The PR row caches these checks too; a rerun decided on its answer could miss a fresh failure.
      expect(checksAsked).toEqual([[repo, 12, "acme/web", { fresh: true }]]);
      expect(reruns).toEqual([
        [repo, "acme/web", "7"],
        [repo, "acme/web", "8"],
      ]);

      checkRuns = [check("ci/external", "failing")];
      expect(yield* rerun.pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidState",
        message: "The failed checks don't run on GitHub Actions, so rerun them on their provider.",
      });
      checkRuns = [check("lint", "passing", { runId: "9" })];
      expect(yield* rerun.pipe(Effect.flip)).toMatchObject({
        _tag: "InvalidState",
        message: "No failed checks to rerun.",
      });
      checkRuns = [check("test", "failing", { runId: "13" })];
      expect(yield* rerun.pipe(Effect.flip)).toMatchObject({
        _tag: "GitError",
        message: "run 13 is still in progress",
      });
    }).pipe(Effect.provide(TestLayer)),
  );
});

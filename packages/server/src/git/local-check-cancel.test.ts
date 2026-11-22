// Cancelling Gram's own checks, and never two of one head at once. The runner is a fake that
// waits until it is interrupted, standing in for the check's process group: what is checked is
// that the cancel reaches it, cleans up after it and records why.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import * as nodePath from "node:path";

import { fixture, layer } from "./local-checks-fixture.ts";
import { LocalChecks, type LocalCheck, type LocalCheckRunnerShape } from "./local-checks.ts";
import { hasGit, removeDir, run, write } from "./test-repo.ts";

const PR = { repo: "invented/shop", number: 7 };

const settle = (until: () => boolean) =>
  Effect.gen(function* () {
    for (let n = 0; n < 500 && !until(); n++) yield* Effect.sleep("10 millis");
  });

/** A runner whose every check runs until it is interrupted, recording each start and stop. */
const blocking = () => {
  const started: Array<{ readonly dir: string; readonly base: string }> = [];
  const stopped: Array<string> = [];
  const runner: LocalCheckRunnerShape["run"] = (dir, _log, _run, source) =>
    Effect.sync(() => void started.push({ dir, base: source.base })).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => void stopped.push(source.base))),
    );
  return { started, stopped, run: runner };
};

/** A commit on `main` past `base`, which it descends from. */
const advanceMain = (repo: string) => {
  write(nodePath.join(repo, "later.txt"), "later\n");
  run(repo, "add", "later.txt");
  run(repo, "commit", "-q", "-m", "later");
  return run(repo, "rev-parse", "HEAD").trim();
};

describe.skipIf(!hasGit || process.platform === "win32")("cancelling a local check", () => {
  it.live(
    "stops the check of a PR, removes its worktree, tells its listeners why, and a new ask runs it again",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        const runner = blocking();
        try {
          yield* Effect.gen(function* () {
            const checks = yield* LocalChecks;
            const done = yield* Deferred.make<LocalCheck>();
            const first = yield* checks.ensure(repo, head, base, {
              since: 0,
              pr: PR,
              onDone: (check) => Deferred.succeed(done, check).pipe(Effect.asVoid),
            });
            expect(first?.status).toBe("running");
            yield* settle(() => runner.started.length > 0);
            const work = runner.started[0]!.dir;
            expect(existsSync(work)).toBe(true);
            // Another PR's cancel leaves it alone.
            expect(yield* checks.cancel({ ...PR, number: 8 }, "invented")).toEqual([]);
            const cancelled = yield* checks.cancel(
              { repo: "Invented/Shop", number: 7 },
              "the pull request merged",
            );
            expect(cancelled).toHaveLength(1);
            expect(runner.stopped).toEqual([base]);
            expect(existsSync(nodePath.dirname(work))).toBe(false);
            const told = yield* Deferred.await(done);
            expect(told).toMatchObject({
              status: "failed",
              cancelled: "the pull request merged",
              reason: "cancelled: the pull request merged",
            });
            expect(told).not.toHaveProperty("job");
            expect(yield* checks.lookup(repo, head, base)).toMatchObject({
              cancelled: "the pull request merged",
            });
            // A cancel isn't a verdict on the code: asked again, even before `since`, it runs.
            const again = yield* checks.ensure(repo, head, base, {
              since: 0,
              pr: PR,
              onDone: () => Effect.void,
            });
            expect(again?.status).toBe("running");
            yield* settle(() => runner.started.length > 1);
            expect(runner.started).toHaveLength(2);
            expect(yield* checks.cancel(PR, "done")).toHaveLength(1);
          }).pipe(Effect.provide(layer(nodePath.join(dir, "gram.db"), dir, runner.run)));
        } finally {
          removeDir(dir);
        }
      }),
  );

  it.live("starts one check for two asks of the same head at once, as the base moves", () =>
    Effect.gen(function* () {
      const { dir, repo, head, base } = fixture();
      const newer = advanceMain(repo);
      const runner = blocking();
      try {
        yield* Effect.gen(function* () {
          const checks = yield* LocalChecks;
          const ends: Array<LocalCheck> = [];
          const ask = (on: string) =>
            checks.ensure(repo, head, on, {
              since: 0,
              pr: PR,
              onDone: (check) => Effect.sync(() => void ends.push(check)),
            });
          yield* ask(base);
          yield* settle(() => runner.started.length > 0);
          // A merge's look and the thread's own local_check, both on the moved base.
          const [a, b] = yield* Effect.all([ask(newer), ask(newer)], { concurrency: "unbounded" });
          expect([a?.status, b?.status]).toEqual(["running", "running"]);
          yield* settle(() => runner.started.length > 1);
          yield* Effect.sleep("200 millis");
          expect(runner.started.map((each) => each.base)).toEqual([base, newer]);
          yield* checks.cancel(PR, "done");
          // Both asks hear how the one check ended.
          yield* settle(() => ends.length > 2);
          expect(ends.filter((check) => check.base === newer)).toHaveLength(2);
        }).pipe(Effect.provide(layer(nodePath.join(dir, "gram.db"), dir, runner.run)));
      } finally {
        removeDir(dir);
      }
    }),
  );

  it.live(
    "replaces a check of the head on an older base with the one on the base's newer tip, and joins one on any other base",
    () =>
      Effect.gen(function* () {
        const { dir, repo, head, base } = fixture();
        const newer = advanceMain(repo);
        const runner = blocking();
        try {
          yield* Effect.gen(function* () {
            const checks = yield* LocalChecks;
            const ends: Array<LocalCheck> = [];
            const ask = (on: string) =>
              checks.ensure(repo, head, on, {
                since: 0,
                pr: PR,
                onDone: (check) => Effect.sync(() => void ends.push(check)),
              });
            // Its listener asks again on the new base, as merge_when_ready's does once it ends.
            yield* checks.ensure(repo, head, base, {
              since: 0,
              pr: PR,
              onDone: (check) =>
                Effect.sync(() => void ends.push(check)).pipe(Effect.andThen(ask(newer))),
            });
            yield* settle(() => runner.started.length > 0);
            // The base moved on: the old base's check counts for nothing, so it gives way.
            const replacing = yield* ask(newer);
            expect(replacing).toMatchObject({ status: "running", base: newer });
            expect(runner.stopped).toEqual([base]);
            yield* settle(() => ends.length > 0);
            expect(ends).toEqual([
              expect.objectContaining({ base, status: "failed", cancelled: expect.any(String) }),
            ]);
            yield* settle(() => runner.started.length > 1);
            // An ask on the older base, as a stale read has it, joins the running one instead.
            const joined = yield* ask(base);
            expect(joined).toMatchObject({ status: "running", base: newer });
            yield* Effect.sleep("200 millis");
            expect(runner.started.map((each) => each.base)).toEqual([base, newer]);
            yield* checks.cancel(PR, "done");
            yield* settle(() => ends.length > 3);
            expect(ends.filter((check) => check.base === newer)).toHaveLength(3);
          }).pipe(Effect.provide(layer(nodePath.join(dir, "gram.db"), dir, runner.run)));
        } finally {
          removeDir(dir);
        }
      }),
  );
});

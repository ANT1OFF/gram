// Condition wakes on stuck CI (`ciStuck`) and on this machine (`machine`: load, free disk), through
// `schedule_wake` and the engine: once each, after their debounce or hold, not when GitHub can't be
// read, and over a restart.
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { hasGit } from "../git/test-repo.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { WakeConditions } from "../wakes/conditions.ts";
import { ThreadWakes } from "../wakes/thread-wakes.ts";
import { allSent, inServer, sentCount } from "./service-kit.ts";
import {
  completeTurn,
  makeWorld,
  openProject,
  settle,
  waitSent,
  type World,
  withServer,
} from "./test-harness.ts";

/** A plain thread at rest, with the session its wakes are sent to. */
const openPlain = (world: World, title: string) =>
  Effect.gen(function* () {
    const runtimes = yield* ThreadRuntimes;
    const thread = yield* runtimes.create({
      projectRoot: world.repo,
      checkout: { kind: "main", path: world.repo },
      title,
      input: { text: "hello" },
    });
    const session = yield* waitSent(thread.id, 1);
    yield* completeTurn(session);
    return { thread, session };
  });

const job = (name: string, since?: number) => ({
  key: name,
  name,
  url: `https://github.com/acme/app/actions/runs/55/job/${name}`,
  ...(since === undefined ? {} : { since }),
});

describe.skipIf(!hasGit)("condition wakes on CI and the machine", () => {
  it.effect("a job queued past its minutes fires once, after the debounce, naming it", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const conditions = yield* WakeConditions;
        const wakes = yield* ThreadWakes;
        yield* openProject(world);
        const { thread, session } = yield* openPlain(world, "CI");
        const now = yield* Clock.currentTimeMillis;
        const refused = (condition: Record<string, unknown>) =>
          session.callTool("schedule_wake", { condition, note: "x" }).pipe(
            Effect.flip,
            Effect.map((e) => e.message),
          );

        expect(yield* refused({ kind: "ciStuck", repo: "acme/app" })).toContain(
          "Name the `pr` or the `runId`",
        );
        expect(yield* refused({ kind: "ciStuck", repo: "acme/app", pr: 7, runId: 5 })).toContain(
          "not both",
        );
        world.ciStates.set("acme/app@9", null);
        expect(yield* refused({ kind: "ciStuck", repo: "acme/app", runId: 9 })).toContain(
          "has no run 9",
        );
        world.ciStates.set("acme/app#6", { queued: [job("macos", now - 20 * 60_000)] });
        expect(yield* refused({ kind: "ciStuck", repo: "acme/app", pr: 6 })).toContain(
          "That is so already: repo: acme/app, pr: 6, job: macos, queued: 20 min, no runner",
        );

        world.ciStates.set("acme/app#7", { queued: [job("macos", now - 60_000)] });
        const set = yield* session.callTool("schedule_wake", {
          condition: { kind: "ciStuck", repo: "acme/app", pr: 7 },
          note: "rerun on another runner",
        });
        expect(set).toMatchObject({
          condition: { kind: "ciStuck", repo: "acme/app", pr: 7, queuedMinutes: 15 },
          when: "a CI job of acme/app#7 sits queued 15+ min, or a run awaits approval",
        });
        expect((yield* wakes.list).wakes[0]?.condition).toMatchObject({ kind: "ciStuck" });

        // Queued 13 minutes: not yet.
        yield* TestClock.adjust("12 minutes");
        yield* conditions.sweep("ciStuck");
        yield* settle;
        expect(yield* allSent(thread.id)).toHaveLength(1);

        // Past 15, and still queued a minute on: one wake.
        yield* TestClock.adjust("3 minutes");
        yield* conditions.sweep("ciStuck");
        yield* TestClock.adjust("61 seconds");
        const text = (yield* sentCount(thread.id, 2))[1] ?? "";
        expect(text).toContain(
          "for when a CI job of acme/app#7 sits queued 15+ min, or a run awaits approval fired.",
        );
        expect(text).toMatch(
          /```wake-event\ncondition: ciStuck\nrepo: acme\/app\npr: 7\njob: macos\nqueued: 1\d min, no runner\nurl: https:\/\/github\.com\/acme\/app\/actions\/runs\/55\/job\/macos\n```/,
        );
        expect(text).toContain("Your note: rerun on another runner");
        yield* settle;
        expect((yield* wakes.list).wakes).toEqual([]);

        // Gone once fired: still queued, it wakes nobody again.
        yield* conditions.sweep("ciStuck");
        yield* TestClock.adjust("5 minutes");
        yield* settle;
        expect(yield* allSent(thread.id)).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "a job picked up inside the debounce doesn't fire, and a GitHub that can't be read neither fires nor fails",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          const wakes = yield* ThreadWakes;
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "CI");
          const now = yield* Clock.currentTimeMillis;
          world.ciStates.set("acme/app#8", { queued: [job("macos", now)] });
          yield* session.callTool("schedule_wake", {
            condition: { kind: "ciStuck", repo: "acme/app", pr: 8, queuedMinutes: 10 },
            note: "x",
          });
          // Unreadable when set: taken, with the first readable look as the baseline.
          yield* session.callTool("schedule_wake", {
            condition: { kind: "ciStuck", repo: "acme/app", runId: 77 },
            note: "y",
          });

          world.ciStates.set("acme/app#8", { queued: [job("macos", now - 11 * 60_000)] });
          yield* conditions.sweep("ciStuck");
          // A runner takes it before the debounce's look.
          world.ciStates.set("acme/app#8", { queued: [] });
          yield* TestClock.adjust("61 seconds");
          yield* settle;

          // GitHub goes unreachable with the job queued long since: no look tells, none fails.
          world.ciStates.delete("acme/app#8");
          for (let i = 0; i < 3; i++) {
            yield* conditions.sweep("ciStuck");
            yield* TestClock.adjust("2 minutes");
          }
          yield* settle;
          expect(yield* allSent(thread.id)).toHaveLength(1);
          expect((yield* wakes.list).wakes).toHaveLength(2);
        }),
      ),
  );

  it.effect("a run awaiting approval fires, and a run that completes ends the wait saying so", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const conditions = yield* WakeConditions;
        yield* openProject(world);
        const fork = yield* openPlain(world, "Fork PR");
        const run = yield* openPlain(world, "Release run");
        world.ciStates.set("acme/app#76", { queued: [] });
        world.ciStates.set("acme/app@55", { queued: [job("build")] });
        yield* fork.session.callTool("schedule_wake", {
          condition: { kind: "ciStuck", repo: "acme/app", pr: 76 },
          note: "ask a maintainer",
        });
        yield* run.session.callTool("schedule_wake", {
          condition: { kind: "ciStuck", repo: "acme/app", runId: 55 },
          note: "check the release",
        });

        world.ciStates.set("acme/app#76", {
          queued: [],
          approval: { name: "CI", url: "https://github.com/acme/app/actions/runs/71" },
        });
        world.ciStates.set("acme/app@55", { queued: [], completed: "success" });
        yield* conditions.sweep("ciStuck");
        // Other kinds' sweeps inside the debounce leave its pending look alone.
        yield* conditions.sweep("machine");
        yield* conditions.sweep("branchMoved");
        yield* TestClock.adjust("61 seconds");
        expect((yield* sentCount(fork.thread.id, 2))[1]).toContain(
          "job: CI\nstate: awaits approval\nurl: https://github.com/acme/app/actions/runs/71\n```",
        );
        expect((yield* sentCount(run.thread.id, 2))[1]).toContain(
          "run: 55\noutcome: the run completed (success) with no job stuck\n```",
        );
      }),
    ),
  );

  it.effect("a job's queued time, first seen before a restart, still counts after it", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // GitHub gives no queue time: the wake counts from when it first saw the job.
      world.ciStates.set("acme/app#7", { queued: [job("macos")] });
      const threadId = yield* withServer(
        world,
        Effect.gen(function* () {
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "CI");
          yield* session.callTool("schedule_wake", {
            condition: { kind: "ciStuck", repo: "acme/app", pr: 7 },
            note: "rerun",
          });
          return thread.id;
        }),
      );
      yield* TestClock.adjust("20 minutes");
      yield* withServer(
        world,
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          yield* settle;
          yield* conditions.sweep("ciStuck");
          yield* TestClock.adjust("61 seconds");
          const sent = yield* sentCount(threadId, 1);
          expect(sent.at(-1)).toMatch(/job: macos\nqueued: 2\d min, no runner/);
        }),
      );
    }),
  );

  it.effect(
    "a quieter machine fires once its load stays below for forMinutes; a spike restarts the hold",
    () =>
      inServer((world) =>
        Effect.gen(function* () {
          const conditions = yield* WakeConditions;
          yield* openProject(world);
          const { thread, session } = yield* openPlain(world, "Heavy check");

          world.machineLoad = [3, 4, 5];
          const quiet = yield* session
            .callTool("schedule_wake", {
              condition: { kind: "machine", metric: "load", below: 8 },
              note: "x",
            })
            .pipe(Effect.flip);
          expect(quiet.message).toContain("The load is below 8 already: 3.0, 4.0, 5.0");

          world.machineLoad = [28, 26, 20];
          const set = yield* session.callTool("schedule_wake", {
            condition: { kind: "machine", metric: "load", below: 8, forMinutes: 2 },
            note: "run the full check",
          });
          expect(set).toMatchObject({
            condition: { kind: "machine", metric: "load", below: 8, forMinutes: 2 },
            when: "this machine's load stays below 8 for 2 min",
          });
          yield* conditions.sweep("machine");

          // Below for a minute, then a spike: the hold starts again.
          world.machineLoad = [5, 15, 18];
          yield* conditions.sweep("machine");
          yield* TestClock.adjust("90 seconds");
          world.machineLoad = [12, 14, 18];
          yield* conditions.sweep("machine");
          world.machineLoad = [5, 12, 17];
          yield* conditions.sweep("machine");
          yield* TestClock.adjust("90 seconds");
          yield* conditions.sweep("machine");
          yield* settle;
          expect(yield* allSent(thread.id)).toHaveLength(1);

          yield* TestClock.adjust("31 seconds");
          yield* conditions.sweep("machine");
          expect((yield* sentCount(thread.id, 2))[1]).toContain(
            "```wake-event\ncondition: machine\nmetric: load\nload: 5.0\nbelow: 8\nfor: 2 min\ncpus: 8\n```",
          );
          yield* settle;
          yield* TestClock.adjust("5 minutes");
          yield* settle;
          expect(yield* allSent(thread.id)).toHaveLength(2);
        }),
      ),
  );

  it.effect("low free disk fires once, on the waiting thread's repo volume by default", () =>
    inServer((world) =>
      Effect.gen(function* () {
        const conditions = yield* WakeConditions;
        yield* openProject(world);
        const { thread, session } = yield* openPlain(world, "Disk");
        world.diskSpace.set("*", { free: 30e9, total: 500e9 });

        const already = yield* session
          .callTool("schedule_wake", {
            condition: { kind: "machine", metric: "diskFree", belowGB: 40 },
            note: "x",
          })
          .pipe(Effect.flip);
        expect(already.message).toContain("30.0 GB is free at");
        const relative = yield* session
          .callTool("schedule_wake", {
            condition: { kind: "machine", metric: "diskFree", belowGB: 20, path: "repo" },
            note: "x",
          })
          .pipe(Effect.flip);
        expect(relative.message).toContain("`path` is an absolute path");
        // The tool lists `condition` flat; the union still decides what is accepted.
        for (const condition of [
          { kind: "machine", metric: "diskFree", below: 20 },
          { kind: "releasePublished", source: "npm", name: "--registry=evil" },
          { kind: "branchMoved" },
        ]) {
          const malformed = yield* session
            .callTool("schedule_wake", { condition, note: "x" })
            .pipe(Effect.flip);
          expect(malformed.message).toContain("condition:");
        }
        expect(yield* (yield* ThreadWakes).pendingOf(thread.id)).toBe(0);

        const set = yield* session.callTool("schedule_wake", {
          condition: { kind: "machine", metric: "diskFree", belowGB: 20 },
          note: "clean up",
        });
        const path = (set as { condition: { path: string } }).condition.path;
        expect(path).toBe(thread.checkout.repoRoot ?? thread.checkout.path);
        expect(set).toMatchObject({ when: `free disk space at ${path} drops below 20 GB` });

        // A volume is read at most every five minutes.
        world.diskSpace.set("*", { free: 18e9, total: 500e9 });
        yield* conditions.sweep("machine");
        yield* settle;
        expect(yield* allSent(thread.id)).toHaveLength(1);
        yield* TestClock.adjust("5 minutes");
        yield* conditions.sweep("machine");
        expect((yield* sentCount(thread.id, 2))[1]).toContain(
          `metric: diskFree\npath: ${path}\nfreeGB: 18.0\nbelowGB: 20\ntotalGB: 500.0\n\`\`\``,
        );
        yield* TestClock.adjust("10 minutes");
        yield* settle;
        expect(yield* allSent(thread.id)).toHaveLength(2);
      }),
    ),
  );
});

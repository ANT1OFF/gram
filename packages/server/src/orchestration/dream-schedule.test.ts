import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_CHARTER,
  type DreamId,
  type OrchestratorCharter,
  type Thread,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ThreadStore } from "../persistence/thread-store.ts";
import { AutomaticDreamDeferred } from "./automatic-dream.ts";
import { syntheticDream } from "./dream-fixtures.ts";
import { countActivity } from "./dream-recent-items.ts";
import { makeMemoryUpdateSchedule } from "./dream-schedule.ts";

const HOUR = 3_600_000;
const WS = "w-schedule" as WorkspaceId;

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

/** A synthetic workspace with `charter`, a schedule over the real store, and ways to make news. */
const fixture = (charter: Partial<OrchestratorCharter>) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "synthetic" });
    const state: WorkspaceState = {
      workspace: {
        id: WS,
        name: "synthetic",
        projectIds: [project.id],
        homeProjectId: project.id,
        createdAt: 0,
      },
      charter: { ...DEFAULT_CHARTER, ...charter },
    };
    yield* store.putWorkspace(state);
    const started: Array<number> = [];
    let refuse: string | undefined;
    const schedule = makeMemoryUpdateSchedule({
      store,
      discard: () => Effect.void,
      gate: () => Effect.succeed(undefined),
      start: () =>
        Effect.gen(function* () {
          if (refuse !== undefined)
            return yield* Effect.fail(new AutomaticDreamDeferred({ message: refuse }));
          started.push(started.length);
        }),
    });
    let n = 0;
    const learned = (lesson: string | null = "Synthetic lesson.") =>
      store.addWorkerReport(WS, {
        threadId: "t-worker" as ThreadId,
        state: "progress",
        summary: "Synthetic progress.",
        ...(lesson === null ? {} : { learned: lesson }),
        at: 1,
      });
    const merge = () =>
      store.appendOrchestrationEvent(WS, { at: 1, kind: "merge", data: { pr: "#1" } });
    const finished = (completedAt: number) =>
      store.insertThread({
        id: `t-done-${++n}` as ThreadId,
        projectId: project.id,
        title: "synthetic",
        userNamed: false,
        model: { agent: "claude", model: "default" },
        mode: "default",
        checkout: { kind: "main", path: "/synthetic/repo" },
        labels: [],
        pinned: false,
        parked: false,
        unread: false,
        createdAt: 0,
        lastActivityAt: completedAt,
        completedAt,
        completedReason: "agent",
      } as Thread);
    /** An update that began at `at`: the last one the time condition counts from. */
    const began = (at: number) =>
      store.putDream({ ...syntheticDream(`dream-began-${++n}` as DreamId, WS), createdAt: at });
    const count = Effect.gen(function* () {
      return (yield* countActivity(store, yield* store.getWorkspace(WS))).total;
    });
    const pass = Effect.gen(function* () {
      const before = started.length;
      yield* schedule.scheduledPass;
      return started.length > before;
    });
    return {
      store,
      schedule,
      learned,
      merge,
      finished,
      began,
      count,
      pass,
      refuseWith: (why: string | undefined) => {
        refuse = why;
      },
    };
  });

describe("automatic memory updates wait for both time and activity", () => {
  it.effect("start nothing while too little has happened, however long it has been", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture({ memoryUpdateEveryHours: 24, automaticDreamThreshold: 3 });
        yield* f.began(0);
        yield* TestClock.setTime(30 * 24 * HOUR);
        yield* f.learned();
        yield* f.merge();
        expect(yield* f.pass).toBe(false);
        yield* f.finished(5 * HOUR);
        expect(yield* f.pass).toBe(true);
      }),
    ),
  );

  it.effect("start nothing before the hours are up, however much has happened", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture({ memoryUpdateEveryHours: 24, automaticDreamThreshold: 2 });
        yield* TestClock.setTime(10 * HOUR);
        yield* f.began(10 * HOUR);
        for (let i = 0; i < 20; i++) yield* f.learned();
        yield* TestClock.setTime(33 * HOUR);
        expect(yield* f.pass).toBe(false);
        yield* TestClock.setTime(34 * HOUR);
        expect(yield* f.pass).toBe(true);
      }),
    ),
  );

  it.effect("count only what is past the cursor, and only reports that say what they learned", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture({ automaticDreamThreshold: 3 });
        yield* TestClock.setTime(25 * HOUR);
        yield* f.learned();
        yield* f.merge();
        yield* f.finished(5);
        yield* f.learned(null);
        yield* f.learned("  ");
        expect(yield* f.count).toBe(3);
        const reportSeq = yield* f.store.latestWorkerReportSeq(WS);
        const events = yield* f.store.listOrchestrationEventsAfter(WS, 0, ["merge"]);
        yield* f.store.advanceDreamCursor(WS, {
          reportSeq,
          eventSeq: events.at(-1)!.seq,
          at: 10,
        });
        expect(yield* f.count).toBe(0);
        expect(yield* f.pass).toBe(false);
        yield* f.learned();
        yield* f.finished(11);
        yield* f.merge();
        expect(yield* f.count).toBe(3);
        expect(yield* f.pass).toBe(true);
      }),
    ),
  );

  it.effect("keep old charters running: either field alone turns updates on behind both", () =>
    withStore(
      Effect.gen(function* () {
        // Saved with only the old completed-thread threshold: 24 hours by default.
        const threshold = yield* fixture({ automaticDreamThreshold: 1 });
        yield* threshold.began(0);
        yield* threshold.learned();
        yield* TestClock.setTime(23 * HOUR);
        expect(yield* threshold.pass).toBe(false);
        yield* TestClock.setTime(24 * HOUR);
        expect(yield* threshold.pass).toBe(true);
      }),
    ),
  );

  it.effect("keep an old schedule-only charter running once the default minimum is met", () =>
    withStore(
      Effect.gen(function* () {
        const hours = yield* fixture({ memoryUpdateEveryHours: 3 });
        yield* TestClock.setTime(4 * HOUR);
        yield* hours.learned();
        expect(yield* hours.pass).toBe(false);
        const status = yield* hours.schedule.status(WS);
        expect(status).toMatchObject({ threshold: 50, completed: 1, everyHours: 3 });
        for (let i = 0; i < 49; i++) yield* hours.learned();
        expect(yield* hours.pass).toBe(true);
      }),
    ),
  );

  it.effect("run none when neither field is set, and hold while an update runs", () =>
    withStore(
      Effect.gen(function* () {
        const off = yield* fixture({});
        yield* off.learned();
        yield* TestClock.setTime(100 * HOUR);
        expect(yield* off.pass).toBe(false);
        expect((yield* off.schedule.status(WS)).threshold).toBeUndefined();

        yield* off.store.updateWorkspace(WS, (w) => ({
          ...w,
          charter: { ...w.charter, automaticDreamThreshold: 1 },
        }));
        yield* off.store.putDream({
          ...syntheticDream("dream-running" as DreamId, WS),
          status: "running",
          createdAt: 0,
        });
        expect(yield* off.pass).toBe(false);
      }),
    ),
  );

  it.effect("retry a deferred start on the next pass, and say why meanwhile", () =>
    withStore(
      Effect.gen(function* () {
        const f = yield* fixture({ automaticDreamThreshold: 1 });
        yield* f.learned();
        yield* TestClock.setTime(25 * HOUR);
        f.refuseWith("Waiting for the selected memory update model to become available.");
        expect(yield* f.pass).toBe(false);
        expect((yield* f.schedule.status(WS)).detail).toContain("model");
        f.refuseWith(undefined);
        expect(yield* f.pass).toBe(true);
      }),
    ),
  );
});

import { describe, expect, it } from "@effect/vitest";
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  type LabelId,
  type Thread,
  type ThreadId,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ThreadStore } from "./thread-store.ts";

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

const insertThread = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
  const thread = {
    id: "t1",
    projectId: project.id,
    title: "rewrite",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/work/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
  } as unknown as Thread;
  yield* store.insertThread(thread);
  return thread.id as ThreadId;
});

describe("ThreadStore settings and settling", () => {
  it.effect("applies a settings patch in one transaction", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const next = yield* store.updateSettings((s) =>
          applySettingsPatch(s, { agents: { idleEvictMinutes: 30 }, logLevel: "debug" }),
        );
        expect(next.agents).toEqual({ ...DEFAULT_SETTINGS.agents, idleEvictMinutes: 30 });
        expect(yield* store.getSettings).toEqual(next);
      }),
    ),
  );

  it.effect("records why completedAt was set and clears both together", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const id = yield* insertThread;
        expect(yield* store.getCompletedReason(id)).toBeUndefined();

        const settled = yield* store.setCompletion(id, { at: 5, reason: "prMerged" });
        expect(settled.completedAt).toBe(5);
        expect((yield* store.getThread(id)).completedAt).toBe(5);
        expect(yield* store.getCompletedReason(id)).toBe("prMerged");

        const reopened = yield* store.setCompletion(id, undefined);
        expect(reopened).not.toHaveProperty("completedAt");
        expect(yield* store.getCompletedReason(id)).toBeUndefined();
      }),
    ),
  );

  it.effect("refuses to store more than one label on a thread", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const id = yield* insertThread;
        const exit = yield* store
          .updateThread(id, (t) => ({ ...t, labels: ["a", "b"] as unknown as Thread["labels"] }))
          .pipe(Effect.exit);
        expect(Exit.hasDies(exit)).toBe(true);
        const one = yield* store.updateThread(id, (t) => ({ ...t, labels: ["a" as LabelId] }));
        expect(one.labels).toEqual(["a"]);
      }),
    ),
  );
});

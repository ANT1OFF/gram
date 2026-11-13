// A one-flag clear on a thread must not write back the whole thread it read before: an edit that
// commits in between (a rename, an archive) would be lost. The store's statements go to the writer
// worker one at a time, so other fibers commit between a read and a later write.
import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ThreadStore, type ThreadStoreShape } from "../persistence/thread-store.ts";
import { makeLimitResume, type LimitResumeDeps } from "./limit-resume.ts";
import type { Runtime } from "./runtime-state.ts";
import { makeTurnLifecycle, type TurnLifecycleDeps } from "./turn-lifecycle.ts";

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

const id = "raced" as ThreadId;

const seed = (extra: Partial<Thread>) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore;
    const project = yield* store.ensureProject({ root: "/work/repo", name: "repo" });
    yield* store.insertThread({
      id,
      projectId: project.id,
      title: "New thread",
      userNamed: false,
      model: { agent: "claude", model: "synthetic" },
      mode: "default",
      checkout: { kind: "main", path: "/work/repo" },
      labels: [],
      pinned: false,
      parked: false,
      unread: false,
      createdAt: 1,
      lastActivityAt: 1,
      ...extra,
    } as unknown as Thread);
    return store;
  });

/** `store`, with a rename committed right after each read of the thread: the race, every time. */
const renamedAfterRead = (store: ThreadStoreShape): ThreadStoreShape => ({
  ...store,
  getThread: (threadId) =>
    store
      .getThread(threadId)
      .pipe(
        Effect.tap(() =>
          store.updateThread(threadId, (t) => ({ ...t, title: "Renamed", userNamed: true })),
        ),
      ),
});

const runtime = { threadId: id } as unknown as Runtime;
const published: Array<Thread> = [];
const publish = (thread: Thread) => Effect.sync(() => void published.push(thread));

describe("clearing one flag of a thread", () => {
  it.effect("keeps a rename made after the session-used check read the thread", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* seed({ agentSessionUnused: true });
        const lifecycle = makeTurnLifecycle({
          store: renamedAfterRead(store),
          hub: { publish: (event: { readonly thread: Thread }) => publish(event.thread) },
        } as unknown as TurnLifecycleDeps);
        yield* lifecycle.markSessionUsed(runtime);
        const stored = yield* store.getThread(id);
        expect(stored.agentSessionUnused).toBeUndefined();
        expect(stored).toMatchObject({ title: "Renamed", userNamed: true });
      }),
    ),
  );

  it.effect("keeps a rename made after the cleared-limit note was read", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* seed({ limitCleared: { at: 5, resetsAt: 10 } } as Partial<Thread>);
        const limits = makeLimitResume({
          store: renamedAfterRead(store),
          publishUpsert: publish,
          runtimes: new Map(),
        } as unknown as LimitResumeDeps);
        yield* limits.endWaitForUser(runtime);
        const stored = yield* store.getThread(id);
        expect(stored.limitCleared).toBeUndefined();
        expect(stored).toMatchObject({ title: "Renamed", userNamed: true });
      }),
    ),
  );
});

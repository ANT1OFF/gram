// Writes a thread store keeps in order with another thread's launch reservation (a pending merge
// fence): a new main binding of the reserved PR is refused with every binding left as it was, a
// promotion at the followed-PR limit included, which the #651 re-review found losing the PR.
import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { promoteExtraPr } from "../git/extra-prs.ts";
import { ThreadStore } from "./thread-store.ts";

const pr = { repo: "acme/app", number: 12 };
const main = { repo: "acme/app", number: 99, monitor: true };
/** Eight followed PRs, the most a thread follows, #12 among them. */
const followed = Array.from({ length: 8 }, (_, i) => ({
  repo: "acme/app",
  number: i === 0 ? 12 : 100 + i,
  monitor: false,
}));
const fence = {
  key: "acme/app\u0000main",
  moved: [],
  pending: { pr, threadId: "owner" as ThreadId, head: "h1", at: 1 },
};

const thread = (id: string, projectId: string, overrides: Partial<Thread> = {}): Thread =>
  ({
    id,
    projectId,
    title: "t",
    userNamed: false,
    model: { agent: "claude", model: "opus" },
    mode: "default",
    checkout: { kind: "main", path: "/synthetic/repo" },
    labels: [],
    pinned: false,
    parked: false,
    unread: false,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }) as Thread;

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

/** The binder at the followed-PR limit promotes #12, its reducer as `pr.promote` runs it. */
const promote = (store: ThreadStore["Service"]) =>
  Effect.gen(function* () {
    let refused: string | undefined;
    const after = yield* store.updateThread("binder" as ThreadId, (t) => {
      const edit = promoteExtraPr(t, pr);
      refused = edit.refused;
      return edit.thread ?? t;
    });
    return { after, refused };
  });

describe("ThreadStore and a reserved PR", () => {
  it.effect("refuses a promotion of the reserved PR at the followed limit, losing nothing", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "fixture" });
        yield* store.insertThread(
          thread("owner", project.id, { boundPr: { ...pr, monitor: false } }),
        );
        yield* store.insertThread(
          thread("binder", project.id, { boundPr: main, extraPrs: followed }),
        );
        expect(yield* store.reserveMergeFence(fence, pr, "owner" as ThreadId, () => true)).toBe(
          true,
        );
        const { after, refused } = yield* promote(store);
        expect(refused).toBeUndefined();
        // The promotion didn't take, and every binding is as it was: #99 main, all eight followed.
        expect(after.boundPr).toEqual(main);
        expect(after.extraPrs).toEqual(followed);
      }),
    ),
  );

  it.effect("promotes the same PR normally once nothing reserves it", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "fixture" });
        yield* store.insertThread(
          thread("owner", project.id, { boundPr: { ...pr, monitor: false } }),
        );
        yield* store.insertThread(
          thread("binder", project.id, { boundPr: main, extraPrs: followed }),
        );
        const { after } = yield* promote(store);
        expect(after.boundPr?.number).toBe(12);
        expect(after.extraPrs).toHaveLength(8);
        expect(after.extraPrs?.some((each) => each.number === 99)).toBe(true);
      }),
    ),
  );

  it.effect("stores a restored thread that would claim the reserved PR archived", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* ThreadStore;
        const project = yield* store.ensureProject({ root: "/synthetic/repo", name: "fixture" });
        yield* store.insertThread(
          thread("owner", project.id, { boundPr: { ...pr, monitor: false } }),
        );
        expect(
          yield* store.reserveMergeFence(
            { ...fence, pending: { ...fence.pending, branch: "feat/owner" } },
            pr,
            "owner" as ThreadId,
            () => true,
          ),
        ).toBe(true);
        const restored = yield* store.insertThread(
          thread("holder", project.id, {
            checkout: { kind: "worktree", path: "/synthetic/holder", branch: "feat/owner" },
          }),
        );
        expect(restored.parked).toBe(true);
        // A thread that claims nothing reserved is inserted as asked.
        const other = yield* store.insertThread(
          thread("other", project.id, {
            checkout: { kind: "worktree", path: "/synthetic/other", branch: "feat/other" },
          }),
        );
        expect(other.parked).toBe(false);
      }),
    ),
  );
});

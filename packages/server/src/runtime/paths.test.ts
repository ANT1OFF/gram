import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes, type ForkPlan } from "./thread-runtimes.ts";

// One folder spelled two ways. On Windows: drive-letter and segment case, separators and a
// trailing separator. Elsewhere case counts, so: a doubled separator, a `.` segment and a trailing
// separator.
const windows = process.platform === "win32";
const FOLDER = windows ? "C:\\Repo\\x" : "/no-such-root/Repo/x";
const SAME_FOLDER = windows ? "c:/repo/x/" : "/no-such-root//Repo/./x/";
const SIBLING = (name: string) => (windows ? `c:/repo/${name}` : `/no-such-root/Repo/${name}`);
const GRANTED = windows ? "D:\\Shared\\Config" : "/no-such-root/Shared/Config";
const SAME_GRANTED = windows ? "d:/shared/config/" : "/no-such-root//Shared/Config/";

const idleThread = Effect.gen(function* () {
  const runtimes = yield* ThreadRuntimes;
  const thread = yield* runtimes.create({
    projectRoot: FOLDER,
    checkout: { kind: "main", path: FOLDER },
  });
  yield* waitFor("idle", runtimes.status(thread.id).pipe(Effect.map((s) => s === "idle")));
  return thread;
});

describe("runtime path comparisons ignore spelling", () => {
  it.effect("a followed checkout in the thread's own folder isn't recorded as a move", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* idleThread;
      const same = yield* runtimes.setCurrentCheckout(thread.id, {
        kind: "main",
        path: SAME_FOLDER,
      });
      expect(same.currentCheckout).toBeUndefined();
      const moved = yield* runtimes.setCurrentCheckout(thread.id, {
        kind: "worktree",
        path: SIBLING("x-feat"),
      });
      expect(moved.currentCheckout?.path).toBe(SIBLING("x-feat"));
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("fork refuses a checkout with an open session, however it's spelled", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* idleThread;
      const plan: ForkPlan = {
        source: { ...thread, agentSessionId: "source-session" },
        messageId: "m1",
        role: "assistant",
        turnId: undefined,
        resumeAt: "sdk-1",
      };
      const error = yield* runtimes
        .fork(plan, { checkout: { kind: "main", path: SAME_FOLDER } })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "InvalidState",
        message: "Fork into a new worktree: the source checkout is in use",
      });
      const fork = yield* runtimes.fork(plan, {
        checkout: { kind: "worktree", path: SIBLING("y") },
      });
      expect(fork.checkout.path).toBe(SIBLING("y"));
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );

  it.effect("granting a folder again under another spelling keeps one entry", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const thread = yield* idleThread;
      yield* runtimes.addDirectories(thread.id, [GRANTED]);
      const again = yield* runtimes.addDirectories(thread.id, [SAME_GRANTED]);
      expect(again.additionalDirectories).toEqual([GRANTED]);
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

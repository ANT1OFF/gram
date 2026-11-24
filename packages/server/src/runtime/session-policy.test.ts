// What the runtime asks the session policy before a session opens, and before an edit that
// unarchives a thread is stored.

import { describe, expect, it } from "@effect/vitest";
import type { Thread, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { makeSessionPolicy } from "./session-policy.ts";

const ID = "t-worker" as ThreadId;
const thread = (more: Partial<Thread> = {}) =>
  ({
    id: ID,
    title: "Worker",
    model: { agent: "claude", model: "fake" },
    checkout: { kind: "worktree", path: "/w/a", hostId: "m-1" },
    spawnedBy: { threadId: "t-a", feature: "f" },
    parked: true,
    ...more,
  }) as unknown as Thread;

const policyOver = (stored: () => Thread) =>
  makeSessionPolicy({ store: { getThread: () => Effect.sync(stored) } as never });

describe("a session's opening", () => {
  it.effect("is refused where the policy says the thread may not run there", () =>
    Effect.gen(function* () {
      const policy = policyOver(() => thread());
      // With no policy installed, and with one that says nothing, it opens.
      expect(Exit.isSuccess(yield* Effect.exit(policy.opening(thread())))).toBe(true);
      let told = 0;
      let answer: Effect.Effect<string | undefined> = Effect.succeed(undefined);
      yield* policy.methods.setSessionPolicy({
        forThread: () => Effect.die("unused"),
        admitting: () => answer,
        opening: () =>
          Effect.sync(() => {
            told += 1;
          }),
      });
      expect(Exit.isSuccess(yield* Effect.exit(policy.opening(thread())))).toBe(true);
      expect(told).toBe(1);
      // Refused: the open fails with the policy's words, and nothing is told of an opening.
      answer = Effect.succeed("Its machine has no place for it.");
      const refused = yield* Effect.exit(policy.opening(thread()));
      expect(Exit.isFailure(refused) && String(refused.cause)).toMatch(/no place for it/);
      expect(told).toBe(1);
      // A policy that dies decides nothing: the session does not open.
      answer = Effect.die("broken");
      expect(Exit.isFailure(yield* Effect.exit(policy.opening(thread())))).toBe(true);
    }),
  );
});

const unarchive = (row: Thread): Thread => ({ ...row, parked: false, title: "Renamed" });

describe("an edit that unarchives a thread", () => {
  it.effect("is stored for the row the decision was made for, and no other", () =>
    Effect.gen(function* () {
      const policy = policyOver(() => thread());
      let answer: string | undefined;
      yield* policy.methods.setSessionPolicy({
        forThread: () => Effect.die("unused"),
        reviving: () => Effect.succeed(answer),
      });
      // Allowed: the edit unarchives the row as it was decided.
      const [, allowed] = yield* policy.methods.unparking(ID, unarchive);
      expect(allowed(thread())).toMatchObject({ parked: false, title: "Renamed" });
      // The row changed hands, or moved, between the decision and its writing: the decision
      // was for another orchestrator's worker or another machine, so the row stays archived.
      const adopted = thread({ spawnedBy: { threadId: "t-b" as ThreadId, feature: "f" } });
      expect(allowed(adopted)).toMatchObject({ parked: true, title: "Renamed" });
      const moved = thread({
        checkout: { kind: "worktree", path: "/w/a", hostId: "m-2" } as never,
      });
      expect(allowed(moved)).toMatchObject({ parked: true });
      // A row no longer archived is not being unarchived by this edit.
      expect(allowed({ ...adopted, parked: false })).toMatchObject({ parked: false });
      // Refused: the rest of the edit is stored, and the thread stays archived.
      answer = "Its machine is full.";
      const [, kept] = yield* policy.methods.unparking(ID, unarchive);
      expect(kept(thread())).toMatchObject({ parked: true, title: "Renamed" });
      // An edit that leaves it archived asks nothing.
      const [, plain] = yield* policy.methods.unparking(ID, (row) => ({ ...row, title: "Only" }));
      expect(plain(thread())).toMatchObject({ parked: true, title: "Only" });
    }),
  );
});

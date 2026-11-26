import { describe, expect, it } from "@effect/vitest";
import { helperOn, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "../platform/unstable.ts";
import { ThreadStore } from "./thread-store.ts";

// What an older build's helper wrote, as this build reads it: the thread-plan keeper and the
// Waiting on you suggestions are gone, and what they stored still loads.

const withStore = <A, E>(effect: Effect.Effect<A, E, ThreadStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(ThreadStore.layerSqlite(":memory:").pipe(Layer.orDie)));

const step = (id: string, source: string) => ({ id, text: `Step ${id}`, status: "todo", source });

const plan = (steps: ReadonlyArray<unknown>, goalBy: string) =>
  JSON.stringify({
    goal: "The helper's goal",
    goalBy,
    steps,
    basis: "rev=3;n=0",
    updatedAt: 1,
    updatedBy: "helper",
  });

describe("what the removed helper jobs left behind", () => {
  it.effect("loads settings saved with the plan and wait switches, keeping only wait's", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const saved = JSON.stringify({ helpers: { plan: false, wait: false, title: false } });
        yield* sql`INSERT INTO settings (key, value) VALUES ('app', ${saved})`;
        const store = yield* ThreadStore;
        const helpers = (yield* store.getSettings).helpers;
        expect(helpers).toEqual({ wait: false, title: false });
        expect(helperOn(yield* store.getSettings, "wait")).toBe(false);
      }),
    ),
  );

  it.effect("reads a plan without the helper's steps and goal, and none when they were all", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ThreadStore;
        yield* sql`INSERT INTO thread_plans (thread_id, plan, turn_plan, rev)
          VALUES ('t-mixed', ${plan([step("h1", "helper"), step("a1", "agent"), step("u1", "user")], "helper")}, NULL, 1)`;
        yield* sql`INSERT INTO thread_plans (thread_id, plan, turn_plan, rev)
          VALUES ('t-helper', ${plan([step("h1", "helper")], "helper")}, NULL, 1)`;
        const mixed = (yield* store.getPlan("t-mixed" as ThreadId)).plan;
        expect(mixed?.steps.map((s) => s.id)).toEqual(["a1", "u1"]);
        expect(mixed?.goal).toBe("");
        expect(mixed?.goalBy).toBeUndefined();
        expect((yield* store.getPlan("t-helper" as ThreadId)).plan).toBeUndefined();
      }),
    ),
  );
});

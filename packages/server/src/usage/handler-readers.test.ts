import { describe, expect, it } from "@effect/vitest";
import type { ThreadId, UsageBreakdown } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { notePrivacy, ReadingAs } from "../embedding/readable-by.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { usageHandlers } from "./handler.ts";

const share = { totals: { totalTokens: 10 }, models: [] };
const breakdown = {
  workspaces: [
    { workspaceId: "w-usage-open", name: "shared", threads: 1, ...share },
    { workspaceId: "w-usage-private", name: "ada-private-plans", threads: 1, ...share },
  ],
  solo: { threads: 0, ...share },
  threads: [],
  outside: [],
} as unknown as UsageBreakdown;

/** A store whose overview names one open workspace and one readable by Ada alone. */
const StubStore = Layer.succeed(ThreadStore, {
  usageOverview: () => Effect.succeed({ totals: { totalTokens: 20 }, rows: [], breakdown }),
} as never);

describe("the usage overview", () => {
  it.effect("names no workspace the caller may not see", () =>
    Effect.gen(function* () {
      notePrivacy({
        id: "t-usage-ada" as ThreadId,
        readableBy: "ada",
        workspaceId: "w-usage-private",
      });
      const handler = yield* usageHandlers;
      const asBob = yield* handler["app.usageOverview"]({ days: 1 }).pipe(
        Effect.provideService(ReadingAs, { subject: "bob" }),
      );
      expect(JSON.stringify(asBob)).not.toMatch(/w-usage-private|ada-private-plans/);
      expect(asBob.breakdown?.workspaces.map((row) => row.workspaceId)).toEqual(["w-usage-open"]);
      const asAda = yield* handler["app.usageOverview"]({ days: 1 }).pipe(
        Effect.provideService(ReadingAs, { subject: "ada" }),
      );
      expect(asAda.breakdown?.workspaces).toHaveLength(2);
    }).pipe(Effect.provide(StubStore)),
  );
});

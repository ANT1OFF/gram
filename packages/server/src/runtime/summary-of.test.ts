import { describe, expect, it } from "@effect/vitest";
import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { RuntimeTestLayer, waitFor } from "./test-harness.ts";
import { ThreadRuntimes } from "./thread-runtimes.ts";

describe("ThreadRuntimes.summaryOf", () => {
  it.effect("is the thread's entry in the snapshot, built alone", () =>
    Effect.gen(function* () {
      const runtimes = yield* ThreadRuntimes;
      const open = (path: string) =>
        runtimes.create({ projectRoot: path, checkout: { kind: "main", path } });
      const warm = yield* open("/work/one");
      const other = yield* open("/work/two");
      yield* waitFor("idle", runtimes.status(warm.id).pipe(Effect.map((s) => s === "idle")));

      const snapshot = yield* runtimes.snapshot;
      for (const id of [warm.id, other.id]) {
        expect(yield* runtimes.summaryOf(id)).toEqual(snapshot.find((s) => s.thread.id === id));
      }
      expect(yield* runtimes.summaryOf("missing" as ThreadId)).toBeUndefined();
    }).pipe(Effect.provide(RuntimeTestLayer)),
  );
});

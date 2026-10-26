import { describe, expect, it } from "@effect/vitest";
import type { PaletteFilter, ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { proposePaletteFilters, PALETTE_FILTER_SYSTEM } from "./palette-filters.ts";
import type { HelperJob, HelperResult, HelperScheduler } from "./scheduler.ts";

const T = "t-palette" as ThreadId;
const workspaces = [{ id: "w-api", name: "agent-platform" }];
function harness(result: HelperResult<{ filters: readonly PaletteFilter[] }>) {
  const jobs: HelperJob<unknown, unknown>[] = [];
  const schedule: HelperScheduler["Service"]["schedule"] = <A, I>(job: HelperJob<A, I>) => {
    jobs.push(job as HelperJob<unknown, unknown>);
    return Effect.succeed(result as HelperResult<A>);
  };
  return { jobs, schedule };
}
describe("palette helper proposals", () => {
  it.effect("schedules fenced sentence only through suggest with a stable content basis", () =>
    Effect.gen(function* () {
      const { jobs, schedule } = harness({
        _tag: "Done",
        cached: false,
        value: { filters: [{ field: "state", value: "failing" }] },
      });
      const result = yield* proposePaletteFilters(
        schedule,
        T,
        "where are broken builds",
        workspaces,
      );
      expect(result).toEqual([{ field: "state", value: "failing" }]);
      const first = jobs[0]!;
      expect(first).toMatchObject({
        kind: "suggest",
        threadId: T,
        lane: "interactive",
        promptVersion: 1,
        system: PALETTE_FILTER_SYSTEM,
      });
      expect(yield* first.prompt).toBe(
        '<material>{"query":"where are broken builds","workspaces":[{"id":"w-api","name":"agent-platform"}]}</material>\nFilters JSON:',
      );
      yield* proposePaletteFilters(schedule, T, "where are broken builds", workspaces);
      expect(jobs[1]!.basis).toBe(first.basis);
      yield* proposePaletteFilters(schedule, T, "where are broken builds", [
        { id: "new", name: "renamed" },
      ]);
      expect(jobs[2]!.basis).not.toBe(first.basis);
    }),
  );
  it.effect("drops invented workspace ids and duplicate fields", () =>
    Effect.gen(function* () {
      const { schedule } = harness({
        _tag: "Done",
        cached: true,
        value: {
          filters: [
            { field: "workspace", value: "invented" },
            { field: "kind", value: "pr" },
            { field: "kind", value: "worker" },
          ],
        },
      });
      expect(
        yield* proposePaletteFilters(schedule, T, "where are broken builds", workspaces),
      ).toEqual([{ field: "kind", value: "pr" }]);
    }),
  );
  it.effect("keeps grammar fallback when the scheduler refuses consent or helpers are off", () =>
    Effect.gen(function* () {
      for (const reason of ["consent", "off", "budget", "auth"] as const) {
        const { schedule } = harness({ _tag: "Skipped", reason });
        expect(
          yield* proposePaletteFilters(schedule, T, "where are broken builds", workspaces),
        ).toEqual([]);
      }
    }),
  );
  it.effect("never schedules commands, short or unbounded text", () =>
    Effect.gen(function* () {
      const { jobs, schedule } = harness({ _tag: "Skipped", reason: "off" });
      for (const query of ["> close all threads", "broken builds", "a ".repeat(300)]) {
        expect(yield* proposePaletteFilters(schedule, T, query, workspaces)).toEqual([]);
      }
      expect(jobs).toHaveLength(0);
    }),
  );
});

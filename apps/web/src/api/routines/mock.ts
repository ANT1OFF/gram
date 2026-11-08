import {
  routineNameKey,
  routineWhenKey,
  type RoutineId,
  type RoutineSchedule,
  type RoutineState,
  type RoutineStatus,
  type WorkspaceId,
  type WorkspaceState,
} from "@gram/contracts";

import { MockInvalidState } from "../mock-fs";
import type { MockWorld } from "../mock-world";
import type { RoutinesApi } from "./types";

const HOUR_MS = 3_600_000;

const keyOf = (workspaceId: WorkspaceId, id: string) => `${workspaceId}\u0000${id}`;

/**
 * The next run after `after` on the browser's own clock. The server reckons it in the machine's
 * zone across daylight-saving changes (`routines/schedule.ts`); the mock only needs a plausible time.
 */
export const mockNextRun = (schedule: RoutineSchedule, after: number): number => {
  if (schedule.every === "hours") return after + schedule.hours * HOUR_MS;
  const [hour = 0, minute = 0] = schedule.at.split(":").map(Number);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(after);
    day.setDate(day.getDate() + offset);
    day.setHours(hour, minute, 0, 0);
    const weekday = day.getDay();
    const runs =
      schedule.every === "day" ||
      (schedule.every === "weekday" && weekday >= 1 && weekday <= 5) ||
      (schedule.every === "week" && weekday === (schedule.day ?? 1));
    if (runs && day.getTime() > after) return day.getTime();
  }
  return after + 24 * HOUR_MS;
};

/**
 * How the mock's routines' runs stand, beside the charters the orchestration mock keeps: a next run
 * reckoned when one is first listed or its schedule changes, and Run now's record.
 */
export function createRoutinesMock(
  world: MockWorld,
  workspaces: () => Promise<readonly WorkspaceState[]>,
) {
  const states = new Map<string, RoutineState>();

  const statusesOf = async (workspaceId: WorkspaceId): Promise<RoutineStatus[]> => {
    const state = (await workspaces()).find((each) => each.workspace.id === workspaceId);
    if (state === undefined) throw new MockInvalidState("No such workspace.");
    const now = Date.now();
    return (state.charter.routines ?? [])
      .map((routine) => {
        const id = (routine.id ?? routineNameKey(routine.name)) as RoutineId;
        const key = keyOf(workspaceId, id);
        const scheduleKey = routineWhenKey(routine);
        let kept = states.get(key) ?? {};
        if (routine.off === true) {
          const { nextRunAt: _next, trigger: _trigger, ...rest } = kept;
          kept = rest;
        } else if (kept.nextRunAt === undefined || kept.scheduleKey !== scheduleKey) {
          // An event routine looks every few minutes, the first look only seeing what is there.
          kept =
            routine.schedule === undefined
              ? {
                  ...kept,
                  nextRunAt: now + 10 * 60_000,
                  scheduleKey,
                  trigger: { seeded: true, lookedAt: now },
                }
              : { ...kept, nextRunAt: mockNextRun(routine.schedule, now), scheduleKey };
        }
        states.set(key, kept);
        return { routine, id, state: kept };
      })
      .toSorted((a, b) => a.routine.name.localeCompare(b.routine.name));
  };

  const api: RoutinesApi = {
    listRoutines: async (workspaceId) => {
      await world.delay(10);
      return statusesOf(workspaceId);
    },
    runRoutine: async (workspaceId, id) => {
      await world.delay(60);
      const state = (await workspaces()).find((each) => each.workspace.id === workspaceId);
      if (state?.paused !== undefined) {
        throw new MockInvalidState("The workspace is paused. Resume it to run its routines.");
      }
      const status = (await statusesOf(workspaceId)).find((each) => each.id === id);
      if (status === undefined)
        throw new MockInvalidState("No such routine. It may have been removed.");
      const lastRun = {
        at: Date.now(),
        outcome: status.routine.target === "orchestrator" ? "messaged" : "started",
        manual: true,
      } as const;
      const next = { ...status.state, lastRun };
      states.set(keyOf(workspaceId, id), next);
      world.emit({ type: "routines.changed", workspaceId });
      return { ...status, state: next };
    },
  };
  return {
    ...api,
    /** How a routine's runs stand, as the server would keep them, for scenes that show past runs. */
    simulateRoutineState(workspaceId: WorkspaceId, id: string, state: RoutineState) {
      states.set(keyOf(workspaceId, id), state);
      world.emit({ type: "routines.changed", workspaceId });
    },
  };
}

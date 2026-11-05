import {
  ROUTINES_PER_WORKSPACE_MAX,
  type Routine,
  type RoutineId,
  type RoutineRun,
  type RoutineSchedule,
  type WorkspaceId,
} from "@gram/contracts";

import { MockInvalidState } from "../mock-fs";
import type { MockWorld } from "../mock-world";
import type { RoutinesApi } from "./types";

const HOUR_MS = 3_600_000;
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as const;

/**
 * The next run after `after` on the browser's own clock. The server reckons it in the routine's
 * zone across daylight-saving changes (`routines/schedule.ts`); the mock only needs a plausible time.
 */
export const mockNextRun = (schedule: RoutineSchedule, after: number): number => {
  if (schedule.kind === "interval") return after + schedule.hours * HOUR_MS;
  const [hour = 0, minute = 0] = schedule.time.split(":").map(Number);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(after);
    day.setDate(day.getDate() + offset);
    day.setHours(hour, minute, 0, 0);
    if (schedule.kind === "weekly" && day.getDay() !== DAY_INDEX[schedule.day]) continue;
    if (day.getTime() > after) return day.getTime();
  }
  return after + 24 * HOUR_MS;
};

/** The routines the mock's workspaces keep, none until Settings or a control adds one. */
export function createRoutinesMock(world: MockWorld) {
  const routines = new Map<string, Routine>();
  const changed = (workspaceId: WorkspaceId) =>
    world.emit({ type: "routines.changed", workspaceId });
  const find = (id: RoutineId) => {
    const routine = routines.get(id);
    if (routine === undefined)
      throw new MockInvalidState("No such routine. It may have been removed.");
    return routine;
  };
  const nameTaken = (workspaceId: WorkspaceId, name: string, id?: string) =>
    [...routines.values()].some(
      (other) =>
        other.workspaceId === workspaceId &&
        other.id !== id &&
        other.name.trim().toLowerCase() === name.trim().toLowerCase(),
    );
  const put = (routine: Routine) => {
    routines.set(routine.id, routine);
    changed(routine.workspaceId);
    return routine;
  };

  const api: RoutinesApi = {
    listRoutines: async (workspaceId) => {
      await world.delay(10);
      return [...routines.values()]
        .filter((routine) => routine.workspaceId === workspaceId)
        .toSorted((a, b) => a.name.localeCompare(b.name));
    },
    createRoutine: async (workspaceId, draft) => {
      await world.delay(40);
      const count = [...routines.values()].filter((r) => r.workspaceId === workspaceId).length;
      if (count >= ROUTINES_PER_WORKSPACE_MAX) {
        throw new MockInvalidState(
          `A workspace keeps at most ${ROUTINES_PER_WORKSPACE_MAX} routines; remove one first.`,
        );
      }
      if (nameTaken(workspaceId, draft.name)) {
        throw new MockInvalidState(`This workspace already has a routine named "${draft.name}".`);
      }
      const now = Date.now();
      const enabled = draft.enabled ?? true;
      return put({
        id: `routine-${world.ids()}` as RoutineId,
        workspaceId,
        name: draft.name.trim(),
        brief: draft.brief,
        target: draft.target,
        schedule: draft.schedule,
        enabled,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        createdAt: now,
        updatedAt: now,
        createdBy: "user",
        ...(enabled ? { nextRunAt: mockNextRun(draft.schedule, now) } : {}),
      });
    },
    updateRoutine: async (id, patch) => {
      await world.delay(40);
      const before = find(id);
      if (patch.name !== undefined && nameTaken(before.workspaceId, patch.name, id)) {
        throw new MockInvalidState(`This workspace already has a routine named "${patch.name}".`);
      }
      const now = Date.now();
      const { nextRunAt: _next, waiting: _waiting, ...rest } = before;
      const merged = { ...rest, ...patch, updatedAt: now };
      const rescheduled =
        (patch.enabled === true && !before.enabled) ||
        (patch.schedule !== undefined &&
          JSON.stringify(patch.schedule) !== JSON.stringify(before.schedule));
      const nextRunAt = !merged.enabled
        ? undefined
        : rescheduled || before.nextRunAt === undefined
          ? mockNextRun(merged.schedule, now)
          : before.nextRunAt;
      return put({ ...merged, ...(nextRunAt === undefined ? {} : { nextRunAt }) });
    },
    removeRoutine: async (id) => {
      await world.delay(20);
      const routine = find(id);
      routines.delete(id);
      changed(routine.workspaceId);
    },
    runRoutine: async (id) => {
      await world.delay(60);
      const routine = find(id);
      const run: RoutineRun = {
        at: Date.now(),
        outcome: routine.target.kind === "orchestrator" ? "messaged" : "started",
        manual: true,
      };
      return put({ ...routine, lastRun: run });
    },
  };
  return {
    ...api,
    /** A routine as the server would keep it, for scenes that show runs past and pending. */
    simulateRoutine(routine: Routine) {
      put(routine);
    },
  };
}

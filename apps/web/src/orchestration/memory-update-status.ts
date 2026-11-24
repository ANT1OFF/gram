import type { AutomaticDreamStatus } from "@gram/contracts";

const HOUR_MS = 3_600_000;

const timeLeft = (dueAt: number | undefined, now: number): string => {
  if (dueAt === undefined || dueAt <= now) return "time is up";
  const ms = dueAt - now;
  return ms < HOUR_MS
    ? `${Math.max(1, Math.ceil(ms / 60_000))} min left`
    : `${Math.ceil(ms / HOUR_MS)} h left`;
};

/**
 * Both conditions of the next automatic memory update and where each stands now, as in
 * "Next update after 24 h and 50 new items: 7 h left, 38 of 50 so far." Undefined when automatic
 * updates are off.
 */
export const nextUpdateText = (status: AutomaticDreamStatus, now: number): string | undefined => {
  if (status.threshold === undefined || status.everyHours === undefined) return undefined;
  return `Next update after ${status.everyHours} h and ${status.threshold} new items: ${timeLeft(
    status.dueAt,
    now,
  )}, ${status.completed} of ${status.threshold} so far.`;
};

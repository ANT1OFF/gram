import {
  ROUTINE_BRIEF_MAX,
  ROUTINE_MAX_INTERVAL_HOURS,
  ROUTINE_MIN_INTERVAL_HOURS,
  ROUTINE_NAME_MAX,
  type ProjectId,
  type Routine,
  type RoutineDay,
  type RoutineDraft,
  type RoutineRun,
} from "@gram/contracts";

import { formatStamp } from "@/lib/time";

/** How a routine's form says its schedule: one of three kinds, each with its own fields. */
export type RoutineEvery = "daily" | "weekly" | "interval";

/** What the routine form edits, as typed: strings until saved. */
export interface RoutineForm {
  readonly name: string;
  readonly brief: string;
  readonly every: RoutineEvery;
  readonly time: string;
  readonly day: RoutineDay;
  readonly hours: string;
  readonly target: "worker" | "orchestrator";
  readonly projectId: ProjectId | undefined;
  /** `agent:model`, or empty for the charter's default. */
  readonly model: string;
}

export const EVERY_OPTIONS: readonly { readonly value: RoutineEvery; readonly label: string }[] = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "interval", label: "Every few hours" },
];

/** A new routine's form: a daily worker in the home repository at 09:00. */
export const emptyRoutineForm = (projectId: ProjectId | undefined): RoutineForm => ({
  name: "",
  brief: "",
  every: "daily",
  time: "09:00",
  day: "mon",
  hours: "6",
  target: "worker",
  projectId,
  model: "",
});

/** A saved routine's form, to edit it. */
export const formOfRoutine = (routine: Routine): RoutineForm => ({
  name: routine.name,
  brief: routine.brief,
  every: routine.schedule.kind,
  time: routine.schedule.kind === "interval" ? "09:00" : routine.schedule.time,
  day: routine.schedule.kind === "weekly" ? routine.schedule.day : "mon",
  hours: routine.schedule.kind === "interval" ? String(routine.schedule.hours) : "6",
  target: routine.target.kind,
  projectId: routine.target.kind === "worker" ? routine.target.projectId : undefined,
  model: routine.target.kind === "worker" ? (routine.target.model ?? "") : "",
});

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The form as a draft the server takes, or what is wrong with it, in the field's words. */
export const draftOfForm = (
  form: RoutineForm,
): { readonly draft: RoutineDraft } | { readonly error: string } => {
  const name = form.name.trim();
  if (name === "") return { error: "Give the routine a name." };
  if (name.length > ROUTINE_NAME_MAX) {
    return { error: `Keep the name to ${ROUTINE_NAME_MAX} characters.` };
  }
  if (form.brief.trim() === "") return { error: "Write the brief it runs with." };
  if (form.brief.length > ROUTINE_BRIEF_MAX) {
    return { error: `Keep the brief to ${ROUTINE_BRIEF_MAX} characters.` };
  }
  let schedule: RoutineDraft["schedule"];
  if (form.every === "interval") {
    const hours = Number(form.hours);
    if (
      !Number.isInteger(hours) ||
      hours < ROUTINE_MIN_INTERVAL_HOURS ||
      hours > ROUTINE_MAX_INTERVAL_HOURS
    ) {
      return {
        error: `Every ${ROUTINE_MIN_INTERVAL_HOURS} to ${ROUTINE_MAX_INTERVAL_HOURS} hours, in whole hours.`,
      };
    }
    schedule = { kind: "interval", hours };
  } else {
    const match = TIME.exec(form.time.trim());
    if (match === null) return { error: "Give the time as HH:MM, on a 24-hour clock." };
    const time = `${match[1]!.padStart(2, "0")}:${match[2]}`;
    schedule =
      form.every === "daily" ? { kind: "daily", time } : { kind: "weekly", day: form.day, time };
  }
  if (form.target === "orchestrator") {
    return { draft: { name, brief: form.brief, schedule, target: { kind: "orchestrator" } } };
  }
  if (form.projectId === undefined) return { error: "Pick the repository its worker starts in." };
  return {
    draft: {
      name,
      brief: form.brief,
      schedule,
      target: {
        kind: "worker",
        projectId: form.projectId,
        ...(form.model === "" ? {} : { model: form.model }),
      },
    },
  };
};

const OUTCOME_WORDS: Readonly<Record<RoutineRun["outcome"], string>> = {
  started: "started a worker",
  messaged: "woke the orchestrator",
  held: "held its brief",
  skipped: "skipped",
  failed: "failed",
};

/** A run in words: "Last ran 09:00, started a worker", with Run now's marked. */
export const lastRunText = (run: RoutineRun, now: number): string =>
  `Last ran ${formatStamp(run.at, now)}${run.manual === true ? " (Run now)" : ""}, ${OUTCOME_WORDS[run.outcome]}`;

/** When it runs next, or why it doesn't: off, or waiting on the workspace's pause. */
export const nextRunText = (routine: Routine, now: number): string => {
  if (!routine.enabled) return "Off";
  if (routine.waiting === "paused") return "Waits for the workspace to resume";
  if (routine.nextRunAt === undefined) return "Not scheduled";
  return routine.nextRunAt <= now ? "Due now" : `Next ${formatStamp(routine.nextRunAt, now)}`;
};

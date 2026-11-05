import {
  ROUTINE_BRIEF_MAX,
  ROUTINE_MAX_INTERVAL_HOURS,
  ROUTINE_MIN_INTERVAL_HOURS,
  ROUTINE_NAME_MAX,
  routineNameKey,
  ROUTINES_MAX,
  type ModelRef,
  type OrchestratorCharter,
  type ProjectId,
  type RoutineRun,
  type RoutineState,
  type WorkerModel,
  type WorkspaceRoutine,
} from "@gram/contracts";

import { formatStamp } from "@/lib/time";

/** How a routine's form says its schedule: one of four kinds, each with its own fields. */
export type RoutineEvery = "day" | "weekday" | "week" | "hours";

/** What the routine form edits, as typed: strings until saved. */
export interface RoutineForm {
  readonly name: string;
  readonly brief: string;
  readonly every: RoutineEvery;
  readonly at: string;
  /** 0 (Sunday) to 6, as `Date.getDay` counts. */
  readonly day: number;
  readonly hours: string;
  readonly target: "worker" | "orchestrator";
  /** Empty for the workspace's home repository. */
  readonly project: string;
  /** `agent:model` of a roster entry, or empty for the workspace's default. */
  readonly model: string;
}

export const EVERY_OPTIONS: readonly { readonly value: RoutineEvery; readonly label: string }[] = [
  { value: "day", label: "Daily" },
  { value: "weekday", label: "Weekdays" },
  { value: "week", label: "Weekly" },
  { value: "hours", label: "Every few hours" },
];

/** A roster entry as the form names it: `agent:model`. */
export const modelLabel = (model: Pick<ModelRef, "agent" | "model">): string =>
  `${model.agent}:${model.model}`;

/** A new routine's form: a daily worker in the home repository at 09:00. */
export const emptyRoutineForm = (): RoutineForm => ({
  name: "",
  brief: "",
  every: "day",
  at: "09:00",
  day: 1,
  hours: "6",
  target: "worker",
  project: "",
  model: "",
});

/** A saved routine's form, to edit it. */
export const formOfRoutine = (routine: WorkspaceRoutine): RoutineForm => ({
  name: routine.name,
  brief: routine.brief,
  every: routine.schedule.every,
  at: routine.schedule.every === "hours" ? "09:00" : routine.schedule.at,
  day: routine.schedule.every === "week" ? (routine.schedule.day ?? 1) : 1,
  hours: routine.schedule.every === "hours" ? String(routine.schedule.hours) : "6",
  target: routine.target === "orchestrator" ? "orchestrator" : "worker",
  project: routine.project ?? "",
  model: routine.model === undefined ? "" : modelLabel(routine.model),
});

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * The form as the routine the charter keeps, or what is wrong with it, in the field's words. Saved
 * over `editing` (its id kept), among `others`, the workspace's other routines; the model is picked
 * from `roster`.
 */
export const routineOfForm = (
  form: RoutineForm,
  options: {
    readonly editing?: WorkspaceRoutine | undefined;
    readonly others: readonly WorkspaceRoutine[];
    readonly roster: readonly WorkerModel[];
  },
): { readonly routine: WorkspaceRoutine } | { readonly error: string } => {
  const name = form.name.trim();
  if (name === "") return { error: "Give the routine a name." };
  if (name.length > ROUTINE_NAME_MAX) {
    return { error: `Keep the name to ${ROUTINE_NAME_MAX} characters.` };
  }
  if (options.others.some((other) => routineNameKey(other.name) === routineNameKey(name))) {
    return { error: `This workspace already has a routine named "${name}".` };
  }
  if (options.editing === undefined && options.others.length >= ROUTINES_MAX) {
    return { error: `A workspace keeps at most ${ROUTINES_MAX} routines; remove one first.` };
  }
  if (form.brief.trim() === "") return { error: "Write the brief it runs with." };
  if (form.brief.length > ROUTINE_BRIEF_MAX) {
    return { error: `Keep the brief to ${ROUTINE_BRIEF_MAX} characters.` };
  }
  let schedule: WorkspaceRoutine["schedule"];
  if (form.every === "hours") {
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
    schedule = { every: "hours", hours };
  } else {
    const match = TIME.exec(form.at.trim());
    if (match === null) return { error: "Give the time as HH:MM, on a 24-hour clock." };
    const at = `${match[1]!.padStart(2, "0")}:${match[2]}`;
    schedule =
      form.every === "week" ? { every: "week", day: form.day, at } : { every: form.every, at };
  }
  const picked =
    form.model === ""
      ? undefined
      : options.roster.find((entry) => modelLabel(entry) === form.model);
  const model: ModelRef | undefined =
    picked === undefined
      ? undefined
      : (({ useFor: _useFor, default: _default, ...ref }) => ref)(picked);
  const editing = options.editing;
  return {
    routine: {
      ...(editing?.id === undefined ? {} : { id: editing.id }),
      name,
      brief: form.brief,
      schedule,
      ...(form.target === "orchestrator" ? { target: "orchestrator" as const } : {}),
      ...(form.target === "worker" && form.project !== ""
        ? { project: form.project as ProjectId }
        : {}),
      ...(form.target === "worker" && model !== undefined ? { model } : {}),
      ...(editing?.off === true ? { off: true as const } : {}),
    },
  };
};

/** The charter with `routines` set, or without the key when none is left. */
export const withRoutines = (
  charter: OrchestratorCharter,
  routines: readonly WorkspaceRoutine[],
): OrchestratorCharter => {
  const { routines: _, ...rest } = charter;
  return routines.length === 0 ? rest : { ...rest, routines };
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
export const nextRunText = (
  routine: Pick<WorkspaceRoutine, "off">,
  state: RoutineState,
  now: number,
): string => {
  if (routine.off === true) return "Off";
  if (state.waiting === "paused") return "Waits for the workspace to resume";
  if (state.nextRunAt === undefined) return "Not scheduled";
  return state.nextRunAt <= now ? "Due now" : `Next ${formatStamp(state.nextRunAt, now)}`;
};

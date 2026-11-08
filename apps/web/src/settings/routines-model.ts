import {
  ROUTINE_BRIEF_MAX,
  ROUTINE_MAX_INTERVAL_HOURS,
  ROUTINE_MIN_INTERVAL_HOURS,
  ROUTINE_NAME_MAX,
  routineNameKey,
  ROUTINES_MAX,
  RoutineTrigger,
  type ModelRef,
  type OrchestratorCharter,
  type ProjectId,
  type RoutineEventKind,
  type RoutineRun,
  type RoutineState,
  type WorkerModel,
  type WorkspaceRoutine,
} from "@gram/contracts";

import * as Schema from "effect/Schema";

import { formatStamp } from "@/lib/time";

/** How a routine's form says its schedule: one of four kinds, each with its own fields. */
export type RoutineEvery = "day" | "weekday" | "week" | "hours";

/** What the routine form edits, as typed: strings until saved. */
export interface RoutineForm {
  readonly name: string;
  readonly brief: string;
  /** On a clock, or when something happens. */
  readonly when: "schedule" | "event";
  readonly event: RoutineEventKind;
  /** `reviewRequested`'s repository, `owner/name`; empty for any. */
  readonly repo: string;
  /** `ciFailed`'s branch; empty for the default branch. */
  readonly branch: string;
  /** `releasePublished`'s registry, package or repo, and wait in days. */
  readonly source: "npm" | "github";
  readonly packageName: string;
  readonly minAgeDays: string;
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

export const WHEN_OPTIONS: readonly {
  readonly value: RoutineForm["when"];
  readonly label: string;
}[] = [
  { value: "schedule", label: "On a schedule" },
  { value: "event", label: "When something happens" },
];

export const EVENT_OPTIONS: readonly {
  readonly value: RoutineEventKind;
  readonly label: string;
}[] = [
  { value: "reviewRequested", label: "A review is requested from me" },
  { value: "prReady", label: "A pull request is ready for review" },
  { value: "ciFailed", label: "CI fails on a branch" },
  { value: "releasePublished", label: "A package publishes a release" },
];

/** A roster entry as the form names it: `agent:model`. */
export const modelLabel = (model: Pick<ModelRef, "agent" | "model">): string =>
  `${model.agent}:${model.model}`;

/** A new routine's form: a daily worker in the home repository at 09:00. */
export const emptyRoutineForm = (): RoutineForm => ({
  name: "",
  brief: "",
  when: "schedule",
  event: "prReady",
  repo: "",
  branch: "",
  source: "npm",
  packageName: "",
  minAgeDays: "7",
  every: "day",
  at: "09:00",
  day: 1,
  hours: "6",
  target: "worker",
  project: "",
  model: "",
});

/** A saved routine's form, to edit it. */
export const formOfRoutine = (routine: WorkspaceRoutine): RoutineForm => {
  const blank = emptyRoutineForm();
  const schedule = routine.schedule;
  const on = routine.on;
  return {
    ...blank,
    name: routine.name,
    brief: routine.brief,
    ...(schedule === undefined
      ? {}
      : {
          every: schedule.every,
          at: schedule.every === "hours" ? blank.at : schedule.at,
          day: schedule.every === "week" ? (schedule.day ?? 1) : 1,
          hours: schedule.every === "hours" ? String(schedule.hours) : blank.hours,
        }),
    ...(on === undefined
      ? {}
      : {
          when: "event" as const,
          event: on.event,
          ...(on.event === "reviewRequested" ? { repo: on.repo ?? "" } : {}),
          ...(on.event === "ciFailed" ? { branch: on.branch ?? "" } : {}),
          ...(on.event === "releasePublished"
            ? {
                source: on.source,
                packageName: on.name,
                minAgeDays: String(on.minAgeDays ?? 7),
              }
            : {}),
        }),
    target: routine.target === "orchestrator" ? "orchestrator" : "worker",
    project: routine.project ?? "",
    model: routine.model === undefined ? "" : modelLabel(routine.model),
  };
};

const decodeTrigger = Schema.decodeUnknownOption(RoutineTrigger);

/** The form's event as the routine keeps it, or what is wrong with it. */
const triggerOfForm = (
  form: RoutineForm,
): { readonly on: RoutineTrigger } | { readonly error: string } => {
  const repo = form.repo.trim();
  const branch = form.branch.trim();
  const name = form.packageName.trim();
  const days = form.minAgeDays.trim();
  if (form.event === "releasePublished") {
    if (name === "") {
      return {
        error:
          form.source === "npm" ? "Name the npm package." : "Name the repository as owner/name.",
      };
    }
    if (form.source === "github" && !/^[\w.-]+\/[\w.-]+$/.test(name)) {
      return { error: "Name the repository as owner/name." };
    }
    const minAgeDays = days === "" ? undefined : Number(days);
    if (
      minAgeDays !== undefined &&
      !(Number.isInteger(minAgeDays) && minAgeDays >= 0 && minAgeDays <= 90)
    ) {
      return { error: "Wait 0 to 90 whole days." };
    }
    const found = decodeTrigger({
      event: "releasePublished",
      source: form.source,
      name,
      ...(minAgeDays === undefined ? {} : { minAgeDays }),
    });
    return found._tag === "Some"
      ? { on: found.value }
      : { error: `"${name}" isn't a package name.` };
  }
  const candidate =
    form.event === "reviewRequested"
      ? { event: form.event, ...(repo === "" ? {} : { repo }) }
      : form.event === "ciFailed"
        ? { event: form.event, ...(branch === "" ? {} : { branch }) }
        : { event: form.event };
  const found = decodeTrigger(candidate);
  if (found._tag === "Some") return { on: found.value };
  return form.event === "reviewRequested"
    ? { error: "Name the repository as owner/name, or leave it empty for any." }
    : { error: `"${branch}" isn't a branch name.` };
};

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
  let on: RoutineTrigger | undefined;
  if (form.when === "event") {
    const made = triggerOfForm(form);
    if ("error" in made) return made;
    on = made.on;
  } else if (form.every === "hours") {
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
      ...(on === undefined ? { schedule: schedule! } : { on }),
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
  `Last ran ${formatStamp(run.at, now)}${run.manual === true ? " (Run now)" : ""}${run.events === undefined ? "" : ` for ${run.events === 1 ? "1 event" : `${run.events} events`}`}, ${OUTCOME_WORDS[run.outcome]}`;

/**
 * When it runs next, or why it doesn't: off, or waiting on the workspace's pause. An event routine
 * says whether it is watching, how many events wait, or why it can't look.
 */
export const nextRunText = (
  routine: Pick<WorkspaceRoutine, "off" | "on">,
  state: RoutineState,
  now: number,
): string => {
  if (routine.off === true) return "Off";
  if (state.waiting === "paused") return "Waits for the workspace to resume";
  if (routine.on !== undefined) {
    const trigger = state.trigger;
    if (trigger?.problem !== undefined) return trigger.problem;
    const waiting = (trigger?.pending?.length ?? 0) + (trigger?.dropped ?? 0);
    if (waiting > 0) return waiting === 1 ? "1 event waiting" : `${waiting} events waiting`;
    if (trigger?.lookedAt === undefined) return "Starts watching";
    return `Watching, checked ${formatStamp(trigger.lookedAt, now)}`;
  }
  if (state.nextRunAt === undefined) return "Not scheduled";
  return state.nextRunAt <= now ? "Due now" : `Next ${formatStamp(state.nextRunAt, now)}`;
};

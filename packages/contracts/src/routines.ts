// Workspace routines (docs/AGENTS_AND_FEATURES.md#routines): a brief kept in the workspace's charter
// and run on a schedule, or when something happens (`on`). Each time one comes due it starts a fresh
// worker in one of the workspace's
// projects, or puts its brief in the orchestrator's next digest. What a routine is lives in the
// charter (`OrchestratorCharter.routines`), so every way of changing it goes through the charter's
// one write path; how its runs went lives in the workspace's outbox (`RoutineState`), and the
// server's engine (`packages/server/src/routines/`) reckons when it next runs.

import * as Schema from "effect/Schema";
import { ModelRef } from "./domain.ts";
import { ProjectId, ThreadId } from "./ids.ts";
import { BranchName, ReleaseName, RepoName } from "./wake-conditions.ts";

/** The most routines one workspace keeps. */
export const ROUTINES_MAX = 8;
export const ROUTINE_NAME_MAX = 64;
export const ROUTINE_BRIEF_MAX = 4000;
/** The shortest interval a routine repeats at: an hour, so a routine never floods a workspace. */
export const ROUTINE_MIN_INTERVAL_HOURS = 1;
/** The longest interval: a week. */
export const ROUTINE_MAX_INTERVAL_HOURS = 168;
/** The longest detail a run keeps. */
export const ROUTINE_RUN_DETAIL_MAX = 500;

/** A routine's id, stable across renames: the key its runs are kept under. */
export const RoutineId = Schema.NonEmptyString.pipe(Schema.brand("RoutineId"));
export type RoutineId = typeof RoutineId.Type;

/** A 24-hour wall-clock time on this computer, `HH:MM`. */
export const RoutineTime = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/** Days as `Date.getDay` counts them, Sunday first, for a weekly routine's `day`. */
export const ROUTINE_DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** Every day, or Monday to Friday, at `at`. */
export const DailySchedule = Schema.Struct({
  every: Schema.Literals(["day", "weekday"]),
  at: RoutineTime,
});
/** One day a week at `at`: `day` 0 (Sunday) to 6, absent is Monday. */
export const WeeklySchedule = Schema.Struct({
  every: Schema.Literal("week"),
  at: RoutineTime,
  day: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
});
/** Every `hours` hours, from the last run (or from when it was turned on). */
export const IntervalSchedule = Schema.Struct({
  every: Schema.Literal("hours"),
  hours: Schema.Int.check(
    Schema.isBetween({
      minimum: ROUTINE_MIN_INTERVAL_HOURS,
      maximum: ROUTINE_MAX_INTERVAL_HOURS,
    }),
  ),
});
export const RoutineSchedule = Schema.Union([DailySchedule, WeeklySchedule, IntervalSchedule]);
export type RoutineSchedule = typeof RoutineSchedule.Type;

// Event triggers (docs/design/event-routines-sources.md): what a routine can start on beside a clock.
// Each is seen by polling, never by a webhook, and closed: an unknown kind doesn't decode.

/** The longest an event routine waits after a run before it fires again. */
export const ROUTINE_EVENT_COOLDOWN_MINUTES = 15;
/** The most events one run's brief lists; the rest are counted. */
export const ROUTINE_EVENTS_PER_RUN = 5;
/** The most events kept waiting for a routine that is busy, cooling down or paused. */
export const ROUTINE_EVENTS_PENDING_MAX = 20;
/** The most delivered occurrence keys a routine keeps, newest last. */
export const ROUTINE_EVENTS_SEEN_MAX = 200;

/** A review is requested from the user, as Notifications' review requests list it; in `repo` only, when named. */
export const ReviewRequestedTrigger = Schema.Struct({
  event: Schema.Literal("reviewRequested"),
  repo: Schema.optionalKey(RepoName),
});
/** A pull request in the routine's project opens ready for review, or leaves draft. Bots' PRs aside. */
export const PrReadyTrigger = Schema.Struct({ event: Schema.Literal("prReady") });
/** A completed CI run fails on the newest commit of `branch` of the routine's project (its default branch when absent). */
export const CiFailedTrigger = Schema.Struct({
  event: Schema.Literal("ciFailed"),
  branch: Schema.optionalKey(BranchName),
});
/** A package on npm, or a GitHub repo, publishes a release at least `minAgeDays` old (7 when absent). */
export const ReleasePublishedTrigger = Schema.Struct({
  event: Schema.Literal("releasePublished"),
  source: Schema.Literals(["npm", "github"]),
  name: ReleaseName,
  minAgeDays: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 90 }))),
});
export const RoutineTrigger = Schema.Union([
  ReviewRequestedTrigger,
  PrReadyTrigger,
  CiFailedTrigger,
  ReleasePublishedTrigger,
]);
export type RoutineTrigger = typeof RoutineTrigger.Type;
export type RoutineEventKind = RoutineTrigger["event"];
export const ROUTINE_EVENT_KINDS: ReadonlyArray<RoutineEventKind> = [
  "reviewRequested",
  "prReady",
  "ciFailed",
  "releasePublished",
];

/** "when a review is requested from you", "when CI fails on main". */
export const routineTriggerText = (on: RoutineTrigger): string => {
  switch (on.event) {
    case "reviewRequested":
      return `when a review is requested from you${on.repo === undefined ? "" : ` in ${on.repo}`}`;
    case "prReady":
      return "when a pull request becomes ready for review";
    case "ciFailed":
      return `when CI fails on ${on.branch ?? "the default branch"}`;
    case "releasePublished":
      return `when ${on.name} publishes a release on ${on.source === "npm" ? "npm" : "GitHub"}`;
  }
};

export const RoutineName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ROUTINE_NAME_MAX),
  Schema.isPattern(/\S/),
);
export const RoutineBrief = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ROUTINE_BRIEF_MAX),
  Schema.isPattern(/\S/),
);

export const WorkspaceRoutine = Schema.Struct({
  /**
   * Its key, kept across renames. The charter's write path fills one in for a routine without it
   * (a settings change by chat names routines by name), the one it had when the name matches.
   */
  id: Schema.optionalKey(RoutineId),
  /** Unique within the workspace, case aside; how the user and the orchestrator name it. */
  name: RoutineName,
  /** The worker's brief, or what the orchestrator is told: as the user approved it. */
  brief: RoutineBrief,
  /** When it runs on a clock. A routine has this or `on`, never both. */
  schedule: Schema.optionalKey(RoutineSchedule),
  /** What it runs on instead of a clock: an event seen by polling. */
  on: Schema.optionalKey(RoutineTrigger),
  /**
   * The repo the worker works in; absent is the workspace's home project. A `prReady` or `ciFailed`
   * routine watches this repo too.
   */
  project: Schema.optionalKey(ProjectId),
  /** The worker's model; absent is the roster's default, as for a worker the user starts. */
  model: Schema.optionalKey(ModelRef),
  /** Puts the brief in the orchestrator's next digest instead of starting a worker. */
  target: Schema.optionalKey(Schema.Literal("orchestrator")),
  /** Kept but not run. */
  off: Schema.optionalKey(Schema.Literal(true)),
  /**
   * How many times it has been turned off or on, set by the charter's write path alone
   * (`withRoutineGenerations`): a run that finds another than the one its next run was reckoned
   * for reckons again from now rather than run, however quickly it went off and on again.
   */
  generation: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}).check(
  Schema.makeFilter(
    (routine: { readonly schedule?: unknown; readonly on?: unknown }) =>
      (routine.schedule === undefined) !== (routine.on === undefined) ||
      "A routine runs on a `schedule` or `on` an event: give exactly one.",
  ),
);
export type WorkspaceRoutine = typeof WorkspaceRoutine.Type;

/** What a routine runs on: a schedule, or an event. */
export interface RoutineWhen {
  readonly schedule?: RoutineSchedule | undefined;
  readonly on?: RoutineTrigger | undefined;
}

/** When the routine runs, in words: its schedule or its event. */
export const routineWhenText = (routine: RoutineWhen): string =>
  routine.on !== undefined
    ? routineTriggerText(routine.on)
    : routine.schedule !== undefined
      ? routineScheduleText(routine.schedule)
      : "never";

/**
 * What a routine runs on, as one key: a change of it (another schedule, event or event parameter)
 * reckons the routine again from now, and an event routine looks afresh.
 */
export const routineWhenKey = (routine: RoutineWhen): string =>
  routine.on !== undefined ? JSON.stringify({ on: routine.on }) : JSON.stringify(routine.schedule);

/** `name` as routines are compared: trimmed, case aside. */
export const routineNameKey = (name: string): string => name.trim().toLowerCase();

/** A workspace's routines, their names and ids unique. */
export const WorkspaceRoutines = Schema.Array(WorkspaceRoutine).check(
  Schema.isMaxLength(ROUTINES_MAX),
  Schema.makeFilter((routines: ReadonlyArray<WorkspaceRoutine>) => {
    const names = routines.map((routine) => routineNameKey(routine.name));
    if (new Set(names).size !== names.length) return "Each routine needs a name of its own.";
    const ids = routines.flatMap((routine) => (routine.id === undefined ? [] : [routine.id]));
    return new Set(ids).size === ids.length || "Each routine needs an id of its own.";
  }),
);

/**
 * `next`'s routines, each with an id: its own, else the one a routine of the same name had in
 * `prior`, else `newId()`. Names are trimmed. The charter's write path calls it on every save.
 */
export const withRoutineIds = (
  prior: ReadonlyArray<WorkspaceRoutine> | undefined,
  next: ReadonlyArray<WorkspaceRoutine> | undefined,
  newId: () => string,
): ReadonlyArray<WorkspaceRoutine> | undefined => {
  if (next === undefined) return undefined;
  const byName = new Map(
    (prior ?? []).flatMap((routine) =>
      routine.id === undefined ? [] : [[routineNameKey(routine.name), routine.id] as const],
    ),
  );
  const taken = new Set(next.flatMap((routine) => (routine.id === undefined ? [] : [routine.id])));
  return next.map((routine) => {
    const name = routine.name.trim();
    if (routine.id !== undefined) return name === routine.name ? routine : { ...routine, name };
    const known = byName.get(routineNameKey(name));
    const id = (known !== undefined && !taken.has(known) ? known : newId()) as RoutineId;
    taken.add(id);
    return { ...routine, id, name };
  });
};

/**
 * `next`'s routines with their generation as the charter's write path keeps it: the one each had in
 * `prior` (by id), one more when its `off` flipped, and none for a routine new to the charter.
 * Whatever generation `next` carries is ignored: only this sets it.
 */
export const withRoutineGenerations = (
  prior: ReadonlyArray<WorkspaceRoutine> | undefined,
  next: ReadonlyArray<WorkspaceRoutine> | undefined,
): ReadonlyArray<WorkspaceRoutine> | undefined => {
  if (next === undefined) return undefined;
  const before = new Map(
    (prior ?? []).flatMap((routine) => (routine.id === undefined ? [] : [[routine.id, routine]])),
  );
  return next.map((routine) => {
    const { generation: _given, ...rest } = routine;
    const was = routine.id === undefined ? undefined : before.get(routine.id);
    if (was === undefined) return rest;
    const flipped = (was.off === true) !== (routine.off === true);
    const generation = (was.generation ?? 0) + (flipped ? 1 : 0);
    return generation === 0 ? rest : { ...rest, generation };
  });
};

/** "weekdays at 09:00", "Mondays at 07:30", "every day at 18:00", "every 6 hours". */
export const routineScheduleText = (schedule: RoutineSchedule): string => {
  switch (schedule.every) {
    case "day":
      return `every day at ${schedule.at}`;
    case "weekday":
      return `weekdays at ${schedule.at}`;
    case "week":
      return `${ROUTINE_DAYS[schedule.day ?? 1]}s at ${schedule.at}`;
    default:
      return schedule.hours === 1 ? "every hour" : `every ${schedule.hours} hours`;
  }
};

/** `9:05` or `09:05` as `09:05`; `undefined` for anything else. */
const timeOf = (word: string | undefined) => {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(word ?? "");
  return match === null ? undefined : `${match[1]!.padStart(2, "0")}:${match[2]}`;
};

/**
 * A schedule as the routine tools take it, in a few words: `daily 09:00`, `weekdays 09:00`,
 * `weekly mon 09:00` or `every 6 hours` (24-hour, local time); what is wrong with it otherwise.
 */
export const parseRoutineSchedule = (
  text: string,
): { readonly schedule: RoutineSchedule } | { readonly error: string } => {
  const [kind, first, second, extra] = text.trim().toLowerCase().split(/\s+/);
  if ((kind === "daily" || kind === "weekdays") && second === undefined) {
    const at = timeOf(first);
    if (at !== undefined) return { schedule: { every: kind === "daily" ? "day" : "weekday", at } };
  }
  if (kind === "weekly" && extra === undefined) {
    const day = ROUTINE_DAYS.findIndex(
      (name) => first !== undefined && first.length >= 3 && name.toLowerCase().startsWith(first),
    );
    const at = timeOf(second);
    if (day >= 0 && at !== undefined) return { schedule: { every: "week", day, at } };
  }
  if (kind === "every" && extra === undefined && /^hours?$/.test(second ?? "")) {
    const hours = Number(first);
    if (
      Number.isInteger(hours) &&
      hours >= ROUTINE_MIN_INTERVAL_HOURS &&
      hours <= ROUTINE_MAX_INTERVAL_HOURS
    ) {
      return { schedule: { every: "hours", hours } };
    }
    return {
      error: `An interval is ${ROUTINE_MIN_INTERVAL_HOURS} to ${ROUTINE_MAX_INTERVAL_HOURS} whole hours.`,
    };
  }
  return {
    error: `"${text}" isn't a schedule: give "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM" or "every N hours" (24-hour, local time).`,
  };
};

/**
 * An event as the routine tools take it, in a few words: `review requested [owner/repo]`, `pr
 * ready`, `ci failed [branch]` or `release npm|github <name> [min-age <days>]`; what is wrong
 * with it otherwise.
 */
export const parseRoutineTrigger = (
  text: string,
): { readonly on: RoutineTrigger } | { readonly error: string } => {
  const words = text
    .trim()
    .replace(/^(review|pr|ci)-(requested|ready|failed)(?=\s|$)/i, "$1 $2")
    .split(/\s+/);
  const head = words.slice(0, 2).join(" ").toLowerCase();
  const rest = words.slice(2);
  const valid = Schema.decodeUnknownOption(RoutineTrigger);
  const checked = (candidate: unknown) => {
    const decoded = valid(candidate);
    return decoded._tag === "Some" ? { on: decoded.value } : undefined;
  };
  const found =
    head === "review requested" && rest.length <= 1
      ? checked({ event: "reviewRequested", ...(rest[0] === undefined ? {} : { repo: rest[0] }) })
      : head === "pr ready" && rest.length === 0
        ? checked({ event: "prReady" })
        : head === "ci failed" && rest.length <= 1
          ? checked({ event: "ciFailed", ...(rest[0] === undefined ? {} : { branch: rest[0] }) })
          : words[0]?.toLowerCase() === "release" &&
              (words.length === 3 || (words.length === 5 && words[3]?.toLowerCase() === "min-age"))
            ? checked({
                event: "releasePublished",
                source: words[1]?.toLowerCase(),
                name: words[2],
                ...(words[4] === undefined ? {} : { minAgeDays: Number(words[4]) }),
              })
            : undefined;
  return (
    found ?? {
      error: `"${text}" isn't an event: give "review requested [owner/repo]", "pr ready", "ci failed [branch]" or "release npm|github <name> [min-age <days>]".`,
    }
  );
};

/** A routine's slug, for the feature its workers go under: `routine-ci-triage`. */
export const routineSlug = (name: string): string => {
  // Split into words and cut by hand: a name is input, and `-+$` backtracks on long dash runs.
  let words = name
    .toLowerCase()
    .normalize("NFKD")
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
    .join("-")
    .slice(0, 40);
  while (words.endsWith("-")) words = words.slice(0, -1);
  return `routine-${words === "" ? "run" : words}`;
};

/**
 * How a run went. `started`: a worker started (`threadId`). `messaged`: the brief went to the
 * orchestrator. `held`: the worker's brief was held, and starts by itself (`heldId`). `skipped`:
 * nothing ran, `detail` says why. `failed`: it couldn't run, `detail` says why.
 */
export const RoutineRunOutcome = Schema.Literals([
  "started",
  "messaged",
  "held",
  "skipped",
  "failed",
]);
export type RoutineRunOutcome = typeof RoutineRunOutcome.Type;

export const RoutineRun = Schema.Struct({
  /** Epoch ms it ran. */
  at: Schema.Number,
  outcome: RoutineRunOutcome,
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ROUTINE_RUN_DETAIL_MAX))),
  threadId: Schema.optionalKey(ThreadId),
  heldId: Schema.optionalKey(Schema.String),
  /** The user's Run now, not the schedule. */
  manual: Schema.optionalKey(Schema.Literal(true)),
  /** An event routine's run: how many events it carried. */
  events: Schema.optionalKey(Schema.Int),
});
export type RoutineRun = typeof RoutineRun.Type;

/**
 * One occurrence an event routine saw. `key` is what makes it one (a PR's repo and number, a
 * commit, a version), so it is delivered at most once. `ref`, `title`, `by` and `url` come from
 * GitHub or a registry: data, which a brief fences as untrusted; `detail` is Gram's own words.
 */
export const RoutineEvent = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(300)),
  /** Epoch ms it was first seen. */
  at: Schema.Number,
  ref: Schema.String.check(Schema.isMaxLength(300)),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  by: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
});
export type RoutineEvent = typeof RoutineEvent.Type;

/**
 * How an event routine's watch stands. Reset whenever what it runs on (`RoutineState.scheduleKey`)
 * or its generation changes, so a routine new, changed or back on looks afresh and only records
 * what is there already (`seeded`), never firing for it.
 */
export const RoutineTriggerState = Schema.Struct({
  /** Its first look is done: what was there then is in `seen`. */
  seeded: Schema.optionalKey(Schema.Literal(true)),
  /** Keys delivered, or there at the first look, newest last, at most `ROUTINE_EVENTS_SEEN_MAX`. */
  seen: Schema.optionalKey(Schema.Array(Schema.String)),
  /** What the source compares against beside the keys: a release routine's last version. */
  baseline: Schema.optionalKey(Schema.String),
  /** Seen and not yet delivered: they go to the next run. At most `ROUTINE_EVENTS_PENDING_MAX`. */
  pending: Schema.optionalKey(Schema.Array(RoutineEvent)),
  /** Events dropped past the pending cap since the last run, which the next run's brief counts. */
  dropped: Schema.optionalKey(Schema.Int),
  /** Epoch ms of its last run, which the cooldown counts from. */
  firedAt: Schema.optionalKey(Schema.Number),
  /** Epoch ms of its last look that read the source. */
  lookedAt: Schema.optionalKey(Schema.Number),
  /** Why the last look couldn't read the source, in a line the user can act on. */
  problem: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(ROUTINE_RUN_DETAIL_MAX))),
});
export type RoutineTriggerState = typeof RoutineTriggerState.Type;

/**
 * A routine's one unsettled run (its occurrence), kept before the run starts anything and until it
 * settles: while its brief is held, its worker is being made, or its worker is live. Its
 * `requestId`, named by the routine and the slot it is for, is the spawn's request id, so the worker
 * it makes has one id however often the run is retried. See `routines/routines.ts` for the lifecycle.
 */
export const RoutineClaim = Schema.Struct({
  requestId: Schema.String,
  /** The scheduled time it is for; a Run now's is when it was clicked. */
  slot: Schema.Number,
  manual: Schema.optionalKey(Schema.Literal(true)),
  /** It was held as this brief: once that brief is gone and no worker came of it, it settled. */
  heldId: Schema.optionalKey(Schema.String),
  /** It made this worker: once that worker is gone or finished, it settled. */
  threadId: Schema.optionalKey(ThreadId),
  /** An event routine's run: the events it delivers, taken from `pending` when it was claimed. */
  events: Schema.optionalKey(Schema.Array(RoutineEvent)),
  /** Events it delivers beyond those listed: counted in its brief. */
  more: Schema.optionalKey(Schema.Int),
});
export type RoutineClaim = typeof RoutineClaim.Type;

/** How a routine's runs stand, kept in the workspace's outbox under its id. */
export const RoutineState = Schema.Struct({
  /**
   * Epoch ms it next comes due; absent while it is off. Past it, it runs at once. For an event
   * routine, when it next looks for events.
   */
  nextRunAt: Schema.optionalKey(Schema.Number),
  /** The schedule `nextRunAt` was reckoned for: a new one reckons again from now. */
  scheduleKey: Schema.optionalKey(Schema.String),
  /** The routine's generation `nextRunAt` was reckoned for: an off and on since reckons again. */
  generation: Schema.optionalKey(Schema.Int),
  lastRun: Schema.optionalKey(RoutineRun),
  claim: Schema.optionalKey(RoutineClaim),
  /** The worker its latest run made, a held brief released since included. */
  lastWorker: Schema.optionalKey(ThreadId),
  /** The held brief its latest run left, while it waits. */
  lastHeld: Schema.optionalKey(Schema.String),
  /** Due, and waiting on its workspace's pause: it runs once when the workspace resumes. */
  waiting: Schema.optionalKey(Schema.Literal("paused")),
  /** An event routine's watch. */
  trigger: Schema.optionalKey(RoutineTriggerState),
});
export type RoutineState = typeof RoutineState.Type;

/** A routine as Settings lists it: what the charter has, and how its runs stand. */
export const RoutineStatus = Schema.Struct({
  routine: WorkspaceRoutine,
  id: RoutineId,
  state: RoutineState,
});
export type RoutineStatus = typeof RoutineStatus.Type;

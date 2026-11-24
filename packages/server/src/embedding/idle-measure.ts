import type { ThreadStatus } from "@gram/contracts";
import { DAY_MS } from "../zone-time.ts";

/**
 * Idle machine measurement, observe only: for each worker machine someone else starts on demand
 * (a hosted server's own, or one relayed to this desktop through a signed-in server), whether its
 * compute could have been given back while its threads waited, which gate held it when not, what
 * each wait waited for, and how long a cold machine took from the wake that wanted it to the first
 * turn on it. Nothing here stops, pauses or starts anything: it is the measurement a decision to
 * pause idle machines would be made on. The gates are the safety conditions of such a pause:
 *
 * - `activity`: no turn, queued send, active tool, subagent or open approval or question;
 * - `localWork`: nothing that needs the machine itself runs on it (a background task, a terminal
 *   running a command, or activity that can't be told);
 * - `wakes`: every wake left is one this server holds and fires without the machine;
 * - `durability`: its work would survive the compute going (its last save reached the remote).
 */
export const IDLE_GATES = ["activity", "localWork", "wakes", "durability"] as const;
export type IdleGate = (typeof IDLE_GATES)[number];

/** What holds a machine at work, each under the gate it fails. */
export const IDLE_BLOCKERS = {
  turn: "activity",
  queued: "activity",
  interaction: "activity",
  subagent: "activity",
  background: "localWork",
  terminal: "localWork",
  localUnknown: "localWork",
  localWake: "wakes",
  unsaved: "durability",
} as const satisfies Record<string, IdleGate>;
export type IdleBlocker = keyof typeof IDLE_BLOCKERS;

/** What a waiting thread waits for: who or what will give it its next turn. */
export const WAIT_TRIGGERS = [
  "user",
  "orchestrator",
  "ciReview",
  "runMonitor",
  "scheduleWake",
  "limit",
  "unknown",
] as const;
export type WaitTrigger = (typeof WAIT_TRIGGERS)[number];

/** One thread's facts, as the sampler reads them; nothing here reads the machine. */
export interface IdleThreadFacts {
  readonly status: ThreadStatus;
  /** It compacts its context, or runs subagents, while it reads at rest. */
  readonly compacting?: boolean;
  readonly subagents?: boolean;
  readonly queued: number;
  readonly pendingRequests: number;
  readonly background: number;
  /** Whether a terminal of it runs a command now; undefined when that couldn't be told. */
  readonly terminalBusy: boolean | undefined;
  /** Its armed wakes: on a PR's events, on a condition (by kind), or on a time alone. */
  readonly wakes: ReadonlyArray<{ readonly onPr?: unknown; readonly condition?: string }>;
  readonly runWatches: number;
  readonly prMonitored: boolean;
  readonly limitWait: boolean;
  /** Its latest report is a question or blocker no one has answered. */
  readonly reportStands: boolean;
  /** It reported, so an orchestrator has its word to act on. */
  readonly reported: boolean;
  /** An orchestrator spawned it. */
  readonly worker: boolean;
  /** Its last save of work didn't reach the remote. */
  readonly saveFailed: boolean;
}

const BUSY = new Set<ThreadStatus>(["starting", "running"]);
const ASKING = new Set<ThreadStatus>(["needsApproval", "needsInput"]);

/**
 * The gates a thread fails and what it waits for. `machine` conditions (load, disk free) are read
 * on the machine itself, so a wake on one is local; every other wake is this server's.
 */
export const classifyThread = (
  facts: IdleThreadFacts,
): {
  readonly blockers: ReadonlyArray<IdleBlocker>;
  readonly triggers: ReadonlyArray<WaitTrigger>;
} => {
  const blockers = new Set<IdleBlocker>();
  if (BUSY.has(facts.status) || facts.compacting === true) blockers.add("turn");
  if (facts.subagents === true) blockers.add("subagent");
  if (facts.queued > 0) blockers.add("queued");
  if (facts.pendingRequests > 0 || ASKING.has(facts.status)) blockers.add("interaction");
  if (facts.background > 0) blockers.add("background");
  if (facts.terminalBusy === true) blockers.add("terminal");
  if (facts.terminalBusy === undefined) blockers.add("localUnknown");
  if (facts.wakes.some((wake) => wake.condition === "machine")) blockers.add("localWake");
  if (facts.saveFailed) blockers.add("unsaved");

  const triggers = new Set<WaitTrigger>();
  if (facts.pendingRequests > 0 || ASKING.has(facts.status)) triggers.add("user");
  if (facts.reportStands) triggers.add("orchestrator");
  if (facts.limitWait) triggers.add("limit");
  for (const wake of facts.wakes)
    triggers.add(wake.onPr !== undefined ? "ciReview" : "scheduleWake");
  if (facts.runWatches > 0) triggers.add("runMonitor");
  if (facts.prMonitored) triggers.add("ciReview");
  if (triggers.size === 0)
    triggers.add(!facts.worker ? "user" : facts.reported ? "orchestrator" : "unknown");
  return { blockers: [...blockers].toSorted(), triggers: [...triggers].toSorted() };
};

/**
 * Where one machine stands at a sample: `offline` (its compute is away already), `finished` (no
 * thread on it is still at work, which the release of finished workers covers), `blocked`, or
 * `eligible`: online, every thread on it at rest and passing every gate.
 */
export type IdleState = "offline" | "finished" | "blocked" | "eligible";

export interface MachineSample {
  readonly state: IdleState;
  readonly blockers: ReadonlyArray<IdleBlocker>;
  readonly triggers: ReadonlyArray<WaitTrigger>;
}

/** A machine's sample from its threads still at work, across every one of them. */
export const classifyMachine = (
  online: boolean,
  threads: ReadonlyArray<IdleThreadFacts>,
): MachineSample => {
  if (!online) return { state: "offline", blockers: [], triggers: [] };
  if (threads.length === 0) return { state: "finished", blockers: [], triggers: [] };
  const blockers = new Set<IdleBlocker>();
  const triggers = new Set<WaitTrigger>();
  for (const thread of threads) {
    const each = classifyThread(thread);
    for (const blocker of each.blockers) blockers.add(blocker);
    for (const trigger of each.triggers) triggers.add(trigger);
  }
  return {
    state: blockers.size === 0 ? "eligible" : "blocked",
    blockers: [...blockers].toSorted(),
    triggers: [...triggers].toSorted(),
  };
};

/** How often machines are sampled. */
export const SAMPLE_EVERY_MS = 60_000;
/** A machine is counted as releasable only after this long eligible in a row: the warm minute. */
export const IDLE_GRACE_MS = 60_000;
/** A sample later than this after the last one starts a new span: the time between is unknown. */
export const SPAN_GAP_MS = 3 * SAMPLE_EVERY_MS;
/** How long spans and wakes are kept. */
export const KEEP_MS = 14 * DAY_MS;

/** A run of samples of one machine that read the same. `to` is the end of its last sample. */
export interface IdleSpan extends MachineSample {
  readonly machine: string;
  readonly kind: MachineKind;
  readonly from: number;
  readonly to: number;
  /** While eligible: since when it has been, across spans whose triggers changed. */
  readonly eligibleSince?: number;
}

/** `hosted`: a host this server was given on demand; `relayed`: one reached through a server. */
export type MachineKind = "hosted" | "relayed";

const sameSample = (a: MachineSample, b: MachineSample) =>
  a.state === b.state &&
  a.blockers.join() === b.blockers.join() &&
  a.triggers.join() === b.triggers.join();

/**
 * `spans` with one machine's sample at `at` added: the machine's last span extended when it reads
 * the same and isn't too old, else a new one. Each sample stands for `SAMPLE_EVERY_MS` from `at`.
 */
export const addSample = (
  spans: ReadonlyArray<IdleSpan>,
  machine: { readonly name: string; readonly kind: MachineKind },
  sample: MachineSample,
  at: number,
): ReadonlyArray<IdleSpan> => {
  let index = -1;
  for (let i = spans.length - 1; i >= 0; i -= 1)
    if (spans[i]!.machine === machine.name) {
      index = i;
      break;
    }
  const last = index === -1 ? undefined : spans[index]!;
  const contiguous = last !== undefined && at >= last.from && at - last.to <= SPAN_GAP_MS;
  const to = at + SAMPLE_EVERY_MS;
  if (contiguous && sameSample(last, sample)) {
    const next = spans.slice();
    next[index] = { ...last, to };
    return next;
  }
  const eligibleSince =
    sample.state !== "eligible"
      ? undefined
      : contiguous && last.state === "eligible"
        ? (last.eligibleSince ?? last.from)
        : at;
  const closed =
    contiguous && last.to > at
      ? spans.map((span, i) => (i === index ? { ...span, to: at } : span))
      : spans;
  return [
    ...closed,
    {
      machine: machine.name,
      kind: machine.kind,
      ...sample,
      from: at,
      to,
      ...(eligibleSince === undefined ? {} : { eligibleSince }),
    },
  ];
};

/** `spans` without what ended before `before`. */
export const pruneSpans = (spans: ReadonlyArray<IdleSpan>, before: number) =>
  spans.filter((span) => span.to >= before);

/**
 * One cold wake of a machine: wanted while away, then back, its folders ready, and its first turn.
 * Each is epoch ms; one not reached is absent. `limitMs` is how long the first turn waited out a
 * provider limit after the machine was ready, counted apart from the session's start.
 */
export interface ResumeTiming {
  readonly machine: string;
  readonly kind: MachineKind;
  readonly wakeAt: number;
  readonly onlineAt?: number;
  readonly readyAt?: number;
  readonly firstTurnAt?: number;
  readonly limitMs?: number;
  /** `turn`: it reached its first turn; `abandoned`: given up on before (`RESUME_GIVE_UP_MS`). */
  readonly outcome: "turn" | "abandoned";
}

/** A wake not at its first turn this long after is recorded as abandoned. */
export const RESUME_GIVE_UP_MS = 30 * 60_000;

/** The segments of a wake, in ms, as far as it got. */
export const resumeSegments = (timing: ResumeTiming) => {
  const { wakeAt, onlineAt, readyAt, firstTurnAt } = timing;
  const limit = timing.limitMs ?? 0;
  return {
    ...(onlineAt === undefined ? {} : { machine: onlineAt - wakeAt }),
    ...(onlineAt === undefined || readyAt === undefined ? {} : { worktree: readyAt - onlineAt }),
    ...(readyAt === undefined || firstTurnAt === undefined
      ? {}
      : { session: Math.max(0, firstTurnAt - readyAt - limit) }),
    ...(timing.limitMs === undefined ? {} : { limit }),
    ...(firstTurnAt === undefined ? {} : { total: firstTurnAt - wakeAt }),
  };
};

/** A wake in progress, as the tracker holds it. */
export interface OpenWake {
  readonly machine: string;
  readonly kind: MachineKind;
  readonly wakeAt: number;
  readonly onlineAt?: number;
  readonly readyAt?: number;
  /** A provider limit the first turn waits out, since when; and what was waited out before. */
  readonly limitSince?: number;
  readonly limitMs?: number;
}

/** What the tracker reads of a machine at each look. */
export interface WakeLook {
  readonly name: string;
  readonly kind: MachineKind;
  readonly onlineSince?: number;
  /** Since when a session has waited on it to be started, while one does. */
  readonly wantedSince?: number;
  /** Its threads' folders are back, or nothing is owed: a session may open on it. */
  readonly settled: boolean;
}

/**
 * The open wake of a machine after a look at it: one opens when a session waits on it while it is
 * away; it learns when the machine came back and when it settled. `undefined`: none open.
 */
export const lookAtWake = (
  open: OpenWake | undefined,
  look: WakeLook,
  now: number,
): OpenWake | undefined => {
  if (open === undefined) {
    if (look.onlineSince !== undefined || look.wantedSince === undefined) return undefined;
    return { machine: look.name, kind: look.kind, wakeAt: look.wantedSince };
  }
  let next = open;
  if (
    next.onlineAt === undefined &&
    look.onlineSince !== undefined &&
    look.onlineSince >= next.wakeAt
  )
    next = { ...next, onlineAt: look.onlineSince };
  if (next.onlineAt !== undefined && look.onlineSince === undefined && next.readyAt === undefined) {
    const { onlineAt: _lost, ...rest } = next;
    next = rest;
  }
  if (next.onlineAt !== undefined && next.readyAt === undefined && look.settled)
    next = { ...next, readyAt: Math.max(now, next.onlineAt) };
  return next;
};

/** The wake with a limit wait begun (`since`) or ended at `now`. */
export const limitOnWake = (open: OpenWake, waiting: boolean, now: number): OpenWake => {
  if (open.readyAt === undefined) return open;
  if (waiting) return open.limitSince === undefined ? { ...open, limitSince: now } : open;
  if (open.limitSince === undefined) return open;
  const { limitSince, ...rest } = open;
  return { ...rest, limitMs: (open.limitMs ?? 0) + Math.max(0, now - limitSince) };
};

/** The wake as recorded once its first turn starts at `now`, or once it is given up on. */
export const closeWake = (
  open: OpenWake,
  now: number,
  outcome: ResumeTiming["outcome"],
): ResumeTiming => {
  const ended = limitOnWake(open, false, now);
  return {
    machine: ended.machine,
    kind: ended.kind,
    wakeAt: ended.wakeAt,
    ...(ended.onlineAt === undefined ? {} : { onlineAt: ended.onlineAt }),
    ...(ended.readyAt === undefined ? {} : { readyAt: ended.readyAt }),
    ...(outcome === "turn" ? { firstTurnAt: now } : {}),
    ...(ended.limitMs === undefined ? {} : { limitMs: ended.limitMs }),
    outcome,
  };
};

/** The `p`th percentile (0–100) of `values`, nearest rank; undefined for none. */
export const percentile = (values: ReadonlyArray<number>, p: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
};

const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

const distribution = (values: ReadonlyArray<number>) => ({
  count: values.length,
  ...(values.length === 0
    ? {}
    : {
        p50Ms: percentile(values, 50)!,
        p95Ms: percentile(values, 95)!,
        maxMs: Math.max(...values),
      }),
});

/**
 * What the measurements came to between `from` and `to`, in machine-minutes: by state, eligible
 * with and without the warm minute (`IDLE_GRACE_MS`), the minutes each blocker and gate held a
 * machine, the eligible minutes by what they waited for, and the latency of the cold wakes in the
 * window with each segment's.
 */
export const summarize = (
  spans: ReadonlyArray<IdleSpan>,
  wakes: ReadonlyArray<ResumeTiming>,
  from: number,
  to: number,
) => {
  const byState: Record<IdleState, number> = { offline: 0, finished: 0, blocked: 0, eligible: 0 };
  const blockers: Partial<Record<IdleBlocker, number>> = {};
  const gates: Partial<Record<IdleGate, number>> = {};
  const waitingOn: Partial<Record<WaitTrigger, number>> = {};
  const eligibleWaitingOn: Partial<Record<WaitTrigger, number>> = {};
  let eligibleAfterGrace = 0;
  const machines = new Set<string>();
  for (const span of spans) {
    const start = Math.max(span.from, from);
    const end = Math.min(span.to, to);
    if (end <= start) continue;
    machines.add(span.machine);
    const length = end - start;
    byState[span.state] += length;
    if (span.state === "blocked") {
      for (const blocker of span.blockers) blockers[blocker] = (blockers[blocker] ?? 0) + length;
      for (const gate of new Set(span.blockers.map((blocker) => IDLE_BLOCKERS[blocker])))
        gates[gate] = (gates[gate] ?? 0) + length;
    }
    if (span.state === "blocked" || span.state === "eligible")
      for (const trigger of span.triggers) waitingOn[trigger] = (waitingOn[trigger] ?? 0) + length;
    if (span.state === "eligible") {
      const releasableFrom = Math.max(start, (span.eligibleSince ?? span.from) + IDLE_GRACE_MS);
      const releasable = Math.max(0, end - releasableFrom);
      eligibleAfterGrace += releasable;
      for (const trigger of span.triggers)
        eligibleWaitingOn[trigger] = (eligibleWaitingOn[trigger] ?? 0) + releasable;
    }
  }
  const asMinutes = <K extends string>(record: Partial<Record<K, number>>) =>
    Object.fromEntries(
      Object.entries<number | undefined>(record)
        .flatMap(([key, ms]) => (ms === undefined ? [] : [[key, ms] as const]))
        .toSorted(([, a], [, b]) => b - a)
        .map(([key, ms]) => [key, minutes(ms)]),
    );
  const online = byState.blocked + byState.eligible + byState.finished;
  const cold = wakes.filter((wake) => wake.wakeAt >= from && wake.wakeAt < to);
  const reached = cold.filter((wake) => wake.outcome === "turn");
  const segment = (name: keyof ReturnType<typeof resumeSegments>) =>
    distribution(
      cold.flatMap((wake) => {
        const value = resumeSegments(wake)[name];
        return value === undefined ? [] : [value];
      }),
    );
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    machines: machines.size,
    minutes: {
      online: minutes(online),
      offline: minutes(byState.offline),
      finished: minutes(byState.finished),
      blocked: minutes(byState.blocked),
      eligible: minutes(byState.eligible),
      eligibleAfterWarmMinute: minutes(eligibleAfterGrace),
    },
    /** Of the minutes machines were online with work, the share they could have been away. */
    eligiblePct:
      byState.blocked + byState.eligible === 0
        ? 0
        : Math.round((eligibleAfterGrace / (byState.blocked + byState.eligible)) * 1000) / 10,
    blockedByGate: asMinutes(gates),
    blockedBy: asMinutes(blockers),
    waitingOn: asMinutes(waitingOn),
    eligibleWaitingOn: asMinutes(eligibleWaitingOn),
    resume: {
      wakes: cold.length,
      abandoned: cold.length - reached.length,
      total: segment("total"),
      machine: segment("machine"),
      worktree: segment("worktree"),
      session: segment("session"),
      limit: segment("limit"),
    },
  };
};
export type IdleSummary = ReturnType<typeof summarize>;

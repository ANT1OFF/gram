import {
  activityGist,
  ciFixOwnedPrs,
  capWords,
  reportGist,
  requestGist,
  type FeatureLedgerEntry,
  type FinishedWorker,
  type OrchestratorLedger,
  type ThreadId,
  type ThreadStatus,
  type ThreadSummary,
  type WorkerLedgerEntry,
  type WorkerState,
} from "@gram/contracts";

import { dateTimeFormat } from "@/lib/intl";
import { threadDisplayTitle } from "@/thread/thread-title";

import { liveWorkerEntry, workerTitle } from "./board-model";
import { dayLabel } from "./outputs-model";
import { ANSWERED, calmTone, workerTone, type RailTone } from "./rail-model";
import { threadWorking } from "./tree-model";
import { OVER_STATES, workerShown } from "./worker-shown";
import { workerActivity, workerWait, type WorkerActivity, type WorkerBusy } from "./wait-model";
import { workerWaitingOn, type ThreadName, type WaitClock, type WaitingOn } from "./waiting-on";

// The ⌘J Workers list: every worker of a workspace in Now and Done, grouped by feature (and in
// Done, by the day it finished), each with a "now" line of four words or fewer. Pure and
// deterministic (no helper model), so it is tested without a browser and two windows always say
// the same thing.

export type WorkersTab = "now" | "done";

export const WORKERS_TABS: readonly { readonly id: WorkersTab; readonly label: string }[] = [
  { id: "now", label: "Now" },
  { id: "done", label: "Done" },
];

export { NOW_LINE_WORDS } from "@gram/contracts";

/** What a row's glyph shows. */
export type WorkerGlyph =
  | "working"
  | "waiting"
  | "needsYou"
  | "error"
  | "idle"
  | "merged"
  | "delivered"
  | "archived";

export interface WorkerRow {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly feature: string;
  readonly repo: string;
  readonly tab: WorkersTab;
  readonly state: WorkerState;
  readonly status: ThreadStatus;
  readonly glyph: WorkerGlyph;
  /** Whether it is busy, and how: the selector Quiet, the sidebar and the Board share. */
  readonly activity: WorkerActivity;
  /** Its tone (`liveWorkerTone`), the one its glyph, Quiet's dot, the Board's chip and the sidebar's dot take. */
  readonly tone: RailTone;
  /** Four words or fewer: what it is doing or where it stands; what it waits on (`waiting`)'s label. */
  readonly now: string;
  /** What it waits on at rest (`workerWaitingOn`), the sidebar's and the Board's words too. */
  readonly waiting?: WaitingOn | undefined;
  /** Epoch ms its work ended, for the done tabs; absent while it goes on. */
  readonly finishedAt?: number | undefined;
  /** The user holds it (`userIntervened`). */
  readonly held: boolean;
  /** Closed with its worktree: it opens read-only, from what Gram kept of it. */
  readonly cleanedUp?: true | undefined;
  /** A solo thread marked done, which ⌘J's Done lists with the workers. */
  readonly solo?: true | undefined;
}

/** A local day finished work is listed under: its midnight, and its heading. */
export interface DoneDay {
  readonly start: number;
  /** `Today`, `Yesterday`, else `Thu 30 Oct`. */
  readonly label: string;
}

export interface WorkerFeature {
  readonly feature: string;
  readonly rows: readonly WorkerRow[];
  /** In Done, the day its rows finished on: a feature that finished over two days is in both. */
  readonly day?: DoneDay | undefined;
}

export type WorkersByTab = Readonly<Record<WorkersTab, readonly WorkerFeature[]>>;

/** The live facts a row reads beside its ledger entry. */
export interface WorkerLiveFacts {
  readonly byId: Readonly<Record<string, ThreadSummary | undefined>>;
  /** The live activity line of each running thread ("Running uv run pytest"). */
  readonly statusDetail: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  readonly ownedCi?: ReadonlySet<string>;
  /** Workers with an ask of theirs in the stack. */
  readonly asking?: ReadonlySet<ThreadId>;
  /** Workers whose asks were answered here, not yet heard from (`useAnsweredWorkers`). */
  readonly answered?: ReadonlySet<ThreadId>;
  /** How a wait's time reads; the viewer's clock at `now` by default. */
  readonly clock?: WaitClock;
}

/** Local midnight `days` days before the day `now` falls on, by the calendar (so across DST too). */
export const daysBefore = (now: number, days: number): number => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - days);
  return day.getTime();
};

/** Local midnight of the day `now` falls on. */
export const startOfDay = (now: number): number => daysBefore(now, 0);

/** The days Done heads one by one, today and the six before it; older work goes by month. */
export const DONE_DAYS = 7;

/** Where finished work with no time to go by is listed: after every day and month. */
const UNDATED: DoneDay = { start: 0, label: "Earlier" };

/** Local midnight of the first of the month `at` falls in. */
export const startOfMonth = (at: number): number => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(1);
  return day.getTime();
};

/**
 * What finished work at `at` is listed under: its day for the last `DONE_DAYS` days, headed as the
 * outputs' days are ("Today", "Yesterday", "Fri 30 Oct"), and its month before that
 * ("October 2026").
 */
export const doneDay = (at: number | undefined, now: number): DoneDay => {
  if (at === undefined) return UNDATED;
  const start = startOfDay(at);
  if (start >= daysBefore(now, DONE_DAYS - 1)) return { start, label: dayLabel(start, now) };
  const month = startOfMonth(at);
  return {
    start: month,
    label: dateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(month)),
  };
};

const pad = (n: number) => String(n).padStart(2, "0");

/** `14:12`, on the 24-hour clock the product's times are on. */
export const clockTime = (at: number): string => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** `14:12` for today, `12 Oct` before: a now line, which is read outside Done's days too. */
export const finishedWhen = (at: number, now: number): string =>
  at >= startOfDay(now)
    ? clockTime(at)
    : dateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(at));

// The now line's words are the feature cards' (contracts `feature-cards.ts`), so a worker reads the
// same in the Workers list and on its card.
export { activityGist, capWords, reportGist, requestGist };

/** The first live request's shell command, when the thread holds it and it is one. */
const requestCommand = (summary: ThreadSummary | undefined): string | undefined => {
  const command = summary?.pendingRequests[0];
  if (command?.kind !== "approval") return undefined;
  const value = command.input["command"];
  return typeof value === "string" ? value : undefined;
};

/** A live worker's glyph by its tone: one look per tone, as every view's dot has it. */
const TONE_GLYPH: Readonly<Record<RailTone, WorkerGlyph>> = {
  needs: "needsYou",
  attention: "needsYou",
  error: "error",
  working: "working",
  waiting: "waiting",
  idle: "idle",
  merged: "merged",
};

const FINISHED_GLYPH: Partial<Record<WorkerState, WorkerGlyph>> = {
  merged: "merged",
  delivered: "delivered",
  archived: "archived",
  done: "delivered",
};

/** When a finished worker's work ended, as near as the facts say. */
const finishedAt = (
  entry: WorkerLedgerEntry,
  summary: ThreadSummary | undefined,
): number | undefined =>
  summary?.thread.completedAt ?? entry.lastReport?.at ?? summary?.thread.lastActivityAt;

/**
 * What a worker does, by the ledger (`workerActivity`) with its thread's live facts laid over: a
 * thread at rest with work still running under it (a background shell, a subagent) is working, as
 * every "N working" count has it (`threadWorking`), rather than idle or waiting.
 */
const liveActivity = (
  live: WorkerLedgerEntry,
  summary: ThreadSummary | undefined,
  detail: string | undefined,
  ownedCi?: ReadonlySet<string>,
): WorkerBusy => {
  const busy = workerActivity(live, live.state, live.status, ownedCi);
  if (busy.activity !== "idle" && busy.activity !== "automation") return busy;
  return summary !== undefined && threadWorking(summary, detail)
    ? { activity: "working", reason: "work running" }
    : busy;
};

/**
 * What a worker waits on (`workerWaitingOn`), by its live activity and tone: only while its tone is
 * calm (`calmTone`), so a wait is never said of a worker at work, asking or failed.
 */
const liveWaiting = (
  live: WorkerLedgerEntry,
  busy: WorkerBusy,
  tone: RailTone,
  now: number,
  clock: WaitClock | undefined,
  name: ThreadName,
): WaitingOn | undefined =>
  calmTone(tone)
    ? workerWaitingOn(live, busy, now, { ...(clock === undefined ? {} : { clock }), name })
    : undefined;

/** What one worker's tone reads beside its ledger entry. */
export interface LiveToneFacts {
  readonly summary: ThreadSummary | undefined;
  /** Its thread's live activity line. */
  readonly detail: string | undefined;
  /** An ask of its is in the stack. */
  readonly asking: boolean;
  /** Its asks were answered here and it isn't heard from yet. */
  readonly answered?: boolean | undefined;
  readonly ownedCi?: ReadonlySet<string> | undefined;
}

/**
 * A worker's tone, the one selector every view's dot, chip and count reads: the Board, the
 * sidebar's rows and lines, the Workers list's glyph and Quiet. Its state is the ledger's with the
 * thread's live status laid over (`liveWorkerEntry`), so a thread that errored is an error before
 * the ledger catches up; working is `threadWorking`, so work running under a resting thread counts;
 * its activity is `liveActivity`. A thread at work that the ledger no longer has (`entry`
 * undefined) has only its live facts.
 */
export const liveWorkerTone = (
  entry: WorkerLedgerEntry | undefined,
  { summary, detail, asking, answered, ownedCi }: LiveToneFacts,
): RailTone => {
  const live = entry === undefined ? undefined : liveWorkerEntry(entry, summary);
  return workerTone({
    asking,
    answered,
    state: live?.state,
    failed: live?.state === "error",
    status: summary?.status,
    working: summary !== undefined && threadWorking(summary, detail),
    activity:
      live === undefined ? undefined : liveActivity(live, summary, detail, ownedCi).activity,
  });
};

/**
 * Every worker the ledger has, and whether its work is over: what puts it in Done (`workerRow`'s
 * tab, by `workerWait`) and takes it out of the sidebar and the Board (`workerShown`). Over is
 * merged, delivered or reported done with no open PR, request, standing report, wake or monitored
 * run left, and not at work.
 */
export const ledgerWorkersOver = (
  ledger: Pick<OrchestratorLedger, "features"> | undefined,
  byId: Readonly<Record<string, ThreadSummary | undefined>>,
): ReadonlyMap<ThreadId, boolean> => {
  const entries = (ledger?.features ?? []).flatMap((feature) =>
    feature.workers.map((entry) => liveWorkerEntry(entry, byId[entry.threadId])),
  );
  const ownedCi = ciFixOwnedPrs(entries);
  return new Map(
    entries.map((live) => [
      live.threadId,
      workerWait(live, live.state, live.status, ownedCi).bucket === "done",
    ]),
  );
};

/** Every live worker's tone by thread, and how many of them there are: what each view counts. */
export interface WorkerTones {
  readonly tones: Readonly<Record<string, RailTone>>;
  /** Its live workers: the ledger's unfinished ones and any at work now. */
  readonly live: number;
  /** Of them, those whose tone is working. */
  readonly working: number;
}

/**
 * The tones of a workspace's live workers (`liveWorkerTone`): the ledger's workers that show
 * (`workerShown`), plus the threads at work there now (`running`), whatever the ledger says. A
 * finished worker at work again counts as working, as its row has it; one at rest stays out.
 */
export const workerTones = (
  ledger: Pick<OrchestratorLedger, "features"> | undefined,
  running: readonly ThreadId[],
  { byId, statusDetail, asking = new Set(), answered }: Omit<WorkerLiveFacts, "now" | "ownedCi">,
): WorkerTones => {
  const busy = new Set(running);
  const entries = new Map<ThreadId, WorkerLedgerEntry | undefined>();
  const all = (ledger?.features ?? []).flatMap((feature) => feature.workers);
  const facts = { running: busy, asking, over: ledgerWorkersOver(ledger, byId) };
  for (const entry of all) {
    if (!workerShown(entry, facts)) continue;
    // One at rest whose state is over (shown for an open PR, say) keeps its ledger facts; one at
    // work again has only its live ones, as its row is working.
    const settled = OVER_STATES.has(entry.state) && busy.has(entry.threadId);
    entries.set(entry.threadId, settled ? undefined : entry);
  }
  for (const threadId of running) if (!entries.has(threadId)) entries.set(threadId, undefined);
  const ownedCi = ciFixOwnedPrs(all.map((entry) => liveWorkerEntry(entry, byId[entry.threadId])));
  const tones: Record<string, RailTone> = {};
  let working = 0;
  for (const [threadId, entry] of entries) {
    const tone = liveWorkerTone(entry, {
      summary: byId[threadId],
      detail: statusDetail[threadId],
      asking: asking.has(threadId),
      answered: answered?.has(threadId),
      ownedCi,
    });
    tones[threadId] = tone;
    if (tone === "working") working += 1;
  }
  return { tones, live: entries.size, working };
};

/**
 * One worker as a row: its live state (the thread's status laid over the ledger's, as the board
 * does), the tab it belongs in, and its now line. A pending request comes first, then a failure,
 * then the end of the road, then what it is running, then where its PR waits, then its report.
 */
export const workerRow = (
  worker: WorkerLedgerEntry,
  { byId, statusDetail, now, ownedCi, asking, answered, clock }: WorkerLiveFacts,
): WorkerRow => {
  const summary = byId[worker.threadId];
  const live = liveWorkerEntry(worker, summary);
  const wait = workerWait(live, live.state, live.status, ownedCi);
  const busy = liveActivity(live, summary, statusDetail[worker.threadId], ownedCi);
  const done = wait.bucket === "done";
  const at = done ? finishedAt(live, summary) : undefined;
  const tab: WorkersTab = done ? "done" : "now";
  const tone = liveWorkerTone(worker, {
    summary,
    detail: statusDetail[worker.threadId],
    asking: asking?.has(worker.threadId) === true,
    answered: answered?.has(worker.threadId),
    ownedCi,
  });
  // Another thread a condition wake waits on is named by its title, as its row names it.
  const name: ThreadName = (id) => {
    const other = byId[id];
    return other === undefined ? undefined : threadDisplayTitle(other.thread);
  };
  const waiting = done ? undefined : liveWaiting(live, busy, tone, now, clock, name);
  const running = live.status === "running" || live.status === "starting";
  const activity = running ? (statusDetail[worker.threadId] ?? live.activity) : undefined;
  const report = live.lastReport;

  const base = {
    threadId: worker.threadId,
    title: workerTitle(worker, summary),
    feature: worker.feature,
    repo: worker.project,
    tab,
    state: live.state,
    status: live.status,
    held: worker.userIntervened,
    activity: busy.activity,
    tone,
    ...(at === undefined ? {} : { finishedAt: at }),
    ...(waiting === undefined ? {} : { waiting }),
  };
  // The glyph is the tone's, as every other view's dot is; a finished worker's says how it ended.
  const row = (finished: WorkerGlyph | undefined, line: string): WorkerRow => ({
    ...base,
    glyph: finished ?? TONE_GLYPH[tone],
    now: capWords(line),
  });

  const [request] = live.pendingRequests;
  if (request !== undefined && answered?.has(worker.threadId) === true) {
    return row(undefined, ANSWERED);
  }
  if (request !== undefined) return row(undefined, requestGist(request, requestCommand(summary)));
  if (live.state === "error") return row(undefined, "stopped on an error");
  if (done) {
    const when = at === undefined ? "" : ` ${finishedWhen(at, now)}`;
    // Archived once merged, as the orchestrator does after a merge, it still reads merged.
    if (
      live.state === "merged" ||
      (live.state === "archived" && live.stateBase?.state === "merged")
    )
      return row("merged", `merged${when}`);
    if (live.state === "archived") return row("archived", `archived${when}`);
    return row(FINISHED_GLYPH[live.state] ?? "delivered", `done${when}`);
  }
  if (running) return row(undefined, activity === undefined ? "working" : activityGist(activity));
  if (live.state === "question" || (live.reportStands === true && report?.state === "question")) {
    return row(undefined, "asked a question");
  }
  if (live.state === "blocked" || live.reportStands === true) return row(undefined, "blocked");
  // What it waits on, in the words the sidebar and the Board use: short already, so not capped.
  if (waiting !== undefined) return { ...row(undefined, ""), now: waiting.label };
  if (live.userIntervened) return row(undefined, "you hold it");
  if (wait.bucket === "person") return row(undefined, wait.tag ?? "waits on a person");
  if (busy.activity === "working") return row(undefined, busy.reason ?? "compacting");
  if (busy.activity === "automation") return row(undefined, busy.reason ?? "waits on checks");
  if (busy.activity === "attention") return row(undefined, busy.reason ?? "needs attention");
  if (live.state === "briefed") return row(undefined, "briefed");
  if (report !== undefined) {
    if (report.state === "done") return row(undefined, "reported done");
    return row(undefined, reportGist(report.summary));
  }
  if (live.quiet?.lastTool !== undefined)
    return row(undefined, `stopped after ${live.quiet.lastTool}`);
  return row(undefined, "idle");
};

/** The repo a finished worker's first PR is in, by its short name, as live rows name theirs. */
const finishedRepo = (worker: FinishedWorker): string => worker.prs[0]?.repo.split("/").pop() ?? "";

/**
 * A worker closed with its worktree, as a done row: merged when its PR's merge completed it, else
 * cleaned up, either way at the time it was closed.
 */
export const finishedRow = (worker: FinishedWorker, now: number): WorkerRow => {
  const merged =
    worker.completedReason === "prMerged" || worker.prs.some((pr) => pr.merged === true);
  const when = finishedWhen(worker.closedAt, now);
  return {
    threadId: worker.threadId,
    title: worker.title,
    feature: worker.feature,
    repo: finishedRepo(worker),
    tab: "done",
    state: merged ? "merged" : "archived",
    status: "idle",
    glyph: merged ? "merged" : "archived",
    activity: "done",
    tone: "merged",
    now: capWords(merged ? `merged ${when}` : `cleaned up ${when}`),
    finishedAt: worker.closedAt,
    held: false,
    cleanedUp: true,
  };
};

/** Where ⌘J's Done lists solo threads among the features: under the overview's name for them. */
export const SOLO_FEATURE = "Solo threads";

/**
 * A solo thread marked done (`doneSoloThreads`), as a row of ⌘J's Done: merged when a merge
 * completed it, else done, at the time it was marked (its last activity, should that be missing).
 */
export const soloWorkerRow = (summary: ThreadSummary, now: number): WorkerRow => {
  const { thread } = summary;
  const merged = thread.completedReason === "prMerged";
  const at = thread.completedAt ?? thread.lastActivityAt;
  return {
    threadId: thread.id,
    title: threadDisplayTitle(thread),
    feature: SOLO_FEATURE,
    repo: "",
    tab: "done",
    state: merged ? "merged" : "done",
    status: summary.status,
    glyph: merged ? "merged" : "delivered",
    activity: "done",
    tone: "merged",
    now: capWords(`${merged ? "merged" : "done"} ${finishedWhen(at, now)}`),
    finishedAt: at,
    held: false,
    solo: true,
  };
};

/**
 * One of Done's groups as ⌘J shows it: its rows by feature, the feature with the latest row first,
 * each feature's rows in the order given (latest first).
 */
export const doneFeatures = (rows: readonly WorkerRow[]): WorkerFeature[] => {
  const features = new Map<string, WorkerRow[]>();
  for (const row of rows) {
    const listed = features.get(row.feature);
    if (listed === undefined) features.set(row.feature, [row]);
    else listed.push(row);
  }
  return [...features].map(([feature, listed]) => ({ feature, rows: listed }));
};

/**
 * Every worker of the workspace by tab, grouped by feature. Now keeps the ledger's feature order
 * and its spawn order within a feature, so rows don't jump as workers change state. Done is by the
 * day each finished, latest first, and within a day by feature, the most recently finished first;
 * archived workers that finished are there too, and every closed one Gram still lists.
 */
export const workersByTab = (
  ledger: Pick<OrchestratorLedger, "features"> | undefined,
  facts: WorkerLiveFacts,
  finished: readonly FinishedWorker[] = [],
): WorkersByTab => {
  const tabs: Record<WorkersTab, WorkerFeature[]> = { now: [], done: [] };
  const add = (tab: WorkersTab, feature: string, rows: readonly WorkerRow[]) => {
    const at = tabs[tab].findIndex((each) => each.feature === feature);
    if (at === -1) tabs[tab].push({ feature, rows });
    else tabs[tab][at] = { feature, rows: [...tabs[tab][at]!.rows, ...rows] };
  };
  const ownedCi = ciFixOwnedPrs(
    (ledger?.features ?? []).flatMap((feature) =>
      feature.workers.map((entry) => liveWorkerEntry(entry, facts.byId[entry.threadId])),
    ),
  );
  for (const feature of ledger?.features ?? []) {
    const rows = feature.workers.map((worker) => workerRow(worker, { ...facts, ownedCi }));
    for (const { id } of WORKERS_TABS) {
      const own = rows.filter((row) => row.tab === id);
      if (own.length > 0) add(id, feature.feature, own);
    }
  }
  // A worker reopened since is live again, and the ledger's row is the one that counts.
  const live = new Set(ledger?.features.flatMap((f) => f.workers.map((w) => w.threadId)));
  for (const worker of finished) {
    if (live.has(worker.threadId)) continue;
    const row = finishedRow(worker, facts.now);
    add(row.tab, row.feature, [row]);
  }
  const done = tabs.done
    .flatMap((feature) => feature.rows)
    .toSorted((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  tabs.done = [];
  for (const row of done) {
    const day = doneDay(row.finishedAt, facts.now);
    const at = tabs.done.findIndex((f) => f.day?.start === day.start && f.feature === row.feature);
    if (at === -1) tabs.done.push({ feature: row.feature, day, rows: [row] });
    else tabs.done[at] = { ...tabs.done[at]!, rows: [...tabs.done[at]!.rows, row] };
  }
  return tabs;
};

/**
 * Each ledger worker's activity by thread, its thread's live status laid over as the Workers list
 * lays it: what the Board and the sidebar's worker rows read, so they and Quiet never disagree.
 */
export const workerActivities = (
  ledger: Pick<OrchestratorLedger, "features"> | undefined,
  byId: WorkerLiveFacts["byId"],
  details: WorkerLiveFacts["statusDetail"] = {},
): Readonly<Record<string, WorkerActivity>> => {
  const live = (ledger?.features ?? []).flatMap((feature) =>
    feature.workers.map((entry) => liveWorkerEntry(entry, byId[entry.threadId])),
  );
  const ownedCi = ciFixOwnedPrs(live);
  return Object.fromEntries(
    live.map((entry) => [
      entry.threadId,
      liveActivity(entry, byId[entry.threadId], details[entry.threadId], ownedCi).activity,
    ]),
  );
};

/**
 * What each ledger worker at rest waits on, by thread (`workerWaitingOn`), read as ⌘J's rows read
 * it: what the sidebar's rows and the Board's chips say, so the three agree. A worker that waits on
 * nothing is left out.
 */
export const workerWaitings = (
  ledger: Pick<OrchestratorLedger, "features"> | undefined,
  facts: WorkerLiveFacts,
): Readonly<Record<string, WaitingOn>> => {
  const { byId } = facts;
  const entries = (ledger?.features ?? []).flatMap((feature) => feature.workers);
  const ownedCi = ciFixOwnedPrs(
    entries.map((entry) => liveWorkerEntry(entry, byId[entry.threadId])),
  );
  const waits: Record<string, WaitingOn> = {};
  for (const entry of entries) {
    const waiting = workerRow(entry, { ...facts, ownedCi }).waiting;
    if (waiting !== undefined) waits[entry.threadId] = waiting;
  }
  return waits;
};

/** How many rows a tab holds. */
export const tabCount = (features: readonly WorkerFeature[]): number =>
  features.reduce((sum, feature) => sum + feature.rows.length, 0);

/** The rows whose name, feature or repo has every word of `query`. */
export const searchRows = <T extends Pick<WorkerRow, "title" | "feature" | "repo">>(
  rows: readonly T[],
  query: string,
): T[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const text = `${row.title} ${row.feature} ${row.repo}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
};

/** The features with only the rows whose name, feature or repo has every word of `query`. */
export const searchWorkers = (features: readonly WorkerFeature[], query: string): WorkerFeature[] =>
  features.flatMap((feature) => {
    const rows = searchRows(feature.rows, query);
    return rows.length === 0 ? [] : [{ ...feature, rows }];
  });

/** The tab the list opens on: Now, unless nothing is going on and something has finished. */
export const openingTab = (tabs: WorkersByTab): WorkersTab =>
  tabs.now.length === 0 && tabs.done.length > 0 ? "done" : "now";

/** A ledger feature's row for one worker, for the worker view's compact status. */
export const workerEntryOf = (
  features: readonly FeatureLedgerEntry[] | undefined,
  threadId: ThreadId,
): WorkerLedgerEntry | undefined =>
  features?.flatMap((feature) => feature.workers).find((worker) => worker.threadId === threadId);

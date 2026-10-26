// Live feature cards:
// each orchestration feature as one card in the orchestrator's stream, which the server builds from
// the ledger, versions and persists, so a newer card replaces the older one and survives a reload.
// The Board, the Quiet status strip and the tray read the same cards (`orchestrator.watchFeatureCards`).
//
// Everything here is a pure function over ledger facts, so the stations, the now line and the event
// budget say the same thing in every view and are tested without a server.

import { ciFixOwnedPrs, ciFixPrKey, ledgerPrsOf } from "./ci-fix-ownership.ts";
import * as Schema from "effect/Schema";
import { ChecksRollup } from "./git.ts";
import { ThreadId, WorkspaceId } from "./ids.ts";
import {
  FEATURE_STAGE_MAX,
  FEATURE_STAGE_NOTE_MAX,
  type DigestChange,
  type FeatureLedgerEntry,
  HeldBrief,
  type OrchestrationDigest,
  type WorkerLedgerEntry,
  type WorkerPendingRequest,
  type WorkerPr,
  WorkerState,
} from "./orchestration.ts";

// ---------------------------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------------------------

/** The five stations of a card's stage line, in order. */
export const FeatureStation = Schema.Literals(["briefed", "working", "checks", "review", "merged"]);
export type FeatureStation = typeof FeatureStation.Type;

export const FEATURE_STATIONS: ReadonlyArray<FeatureStation> = [
  "briefed",
  "working",
  "checks",
  "review",
  "merged",
];

export const STATION_LABELS: Readonly<Record<FeatureStation, string>> = {
  briefed: "Briefed",
  working: "Working",
  checks: "Checks",
  review: "Review",
  merged: "Merged",
};

const stationIndex = (station: FeatureStation): number => FEATURE_STATIONS.indexOf(station);

/** `passing (not required: failing)` → `passing`: the ledger's checks words as a rollup. */
export const checksOf = (checks: string | undefined): ChecksRollup | undefined => {
  const word = checks?.trim().split(/\s/)[0];
  return word === "passing" || word === "failing" || word === "pending" || word === "none"
    ? word
    : undefined;
};

type StationFacts = Pick<WorkerLedgerEntry, "state" | "pr" | "morePrs" | "lastReport">;

/** Where an open PR puts a worker: checks while they run or fail, review once they pass or none. */
const prStation = (pr: WorkerPr): FeatureStation => {
  const checks = checksOf(pr.checks);
  return checks === "pending" || checks === "failing" ? "checks" : "review";
};

/** The station a worker's facts imply when its state alone doesn't say (error, archived). */
const factsStation = (worker: StationFacts): FeatureStation => {
  const prs = [worker.pr, ...(worker.morePrs ?? [])].filter((pr) => pr !== undefined);
  if (prs.length > 0 && prs.every((pr) => pr.state === "merged")) return "merged";
  const open = prs.find((pr) => pr.state === undefined || pr.state === "open");
  if (open !== undefined) return prStation(open);
  if (worker.lastReport?.state === "done") return "review";
  return "working";
};

/**
 * The one station a worker sits at, from its ledger state (deterministic, no model):
 *
 * | state                                      | station                                   |
 * | ------------------------------------------ | ----------------------------------------- |
 * | briefed                                    | briefed                                   |
 * | working, question, needsUser, blocked      | working                                   |
 * | inReview, done with its PR's checks pending or failing | checks                        |
 * | inReview, done with checks passing or none, readyToMerge, done without a PR | review   |
 * | delivered, merged                          | merged                                    |
 * | error, archived                            | `previous`, else what its PR and report say |
 *
 * An errored worker stays at the station it had (`previous`, the card's last word for it) and is
 * flagged (`stationFlag`) rather than moved back.
 */
export const stationOf = (worker: StationFacts, previous?: FeatureStation): FeatureStation => {
  switch (worker.state) {
    case "briefed":
      return "briefed";
    case "working":
    case "question":
    case "needsUser":
    case "blocked":
      return "working";
    case "inReview":
    case "done": {
      const open = [worker.pr, ...(worker.morePrs ?? [])].find(
        (pr) => pr !== undefined && (pr.state === undefined || pr.state === "open"),
      );
      return open === undefined ? "review" : prStation(open);
    }
    case "readyToMerge":
      return "review";
    case "delivered":
    case "merged":
      return "merged";
    case "error":
    case "archived":
      return previous ?? factsStation(worker);
  }
};

/** What marks a worker on its station beside where it is: a failure. */
export const FeatureStationFlag = Schema.Literals(["error"]);
export type FeatureStationFlag = typeof FeatureStationFlag.Type;

export const stationFlag = (
  worker: Pick<WorkerLedgerEntry, "state">,
): FeatureStationFlag | undefined => (worker.state === "error" ? "error" : undefined);

/**
 * A card's own station: its least advanced worker's, leaving parked workers out, which hold nothing
 * back; a card whose every worker is parked keeps the furthest any got.
 */
export const cardStationOf = (
  workers: ReadonlyArray<Pick<FeatureCardWorker, "station" | "state">>,
): FeatureStation => {
  const live = workers.filter((worker) => worker.state !== "archived");
  const pool = live.length > 0 ? live : workers;
  if (pool.length === 0) return "briefed";
  const pick = live.length > 0 ? Math.min : Math.max;
  return FEATURE_STATIONS[pick(...pool.map((worker) => stationIndex(worker.station)))]!;
};

// ---------------------------------------------------------------------------------------------
// The now line
// ---------------------------------------------------------------------------------------------

/** The most words a now line holds. */
export const NOW_LINE_WORDS = 4;

/** At most `NOW_LINE_WORDS` words, an ellipsis saying some were left out. */
export const capWords = (text: string, max = NOW_LINE_WORDS): string => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return `${words.slice(0, max).join(" ")}…`;
};

/** Lowercase a sentence's first letter unless the word is an acronym or a name with capitals. */
const lowerFirst = (text: string): string =>
  /^[A-Z][a-z]/.test(text) ? `${text[0]!.toLowerCase()}${text.slice(1)}` : text;

const TEST_WORDS = /\b(test|tests|suite|pytest|vitest|jest|spec|specs|playwright)\b/i;
/** "38 of 52", "38/52": a count of tests run, as a report says it. */
const COUNT = /\b(\d{1,6})\s*(?:of|\/)\s*(\d{1,6})\b/;

/**
 * A report's gist: a test count when it gives one ("Running the suite; 38 of 52" → "tests 38/52"),
 * else its first clause, four words at most ("Backoff is in. Running…" → "backoff is in").
 */
export const reportGist = (summary: string): string => {
  const count = COUNT.exec(summary);
  if (count !== null && TEST_WORDS.test(summary)) return `tests ${count[1]}/${count[2]}`;
  const clause = summary.trim().split(/[.;:!?\n]\s|[.;:!?\n]$|\s[—–-]\s/)[0] ?? "";
  const gist = capWords(lowerFirst(clause.replace(/[.,;:!?]+$/, "")));
  return gist === "" ? "reported" : gist;
};

/** A command line on its own, by the tools a worker commonly runs. */
const BARE_COMMAND =
  /^((?:git|gh|uv|uvx|npm|npx|pnpm|bun|bunx|yarn|cargo|go|make|pytest|python3?|node|tsc|vitest|jest)\b.*)$/;

const TEST_COMMAND = /\b(test|tests|pytest|vitest|jest|spec|playwright|check)\b/i;

/**
 * The server's activity line ("Running uv run pytest tests/queue", "Editing src/a.ts") as a now
 * line: what kind of thing it is doing, never the path or the command's arguments.
 */
export const activityGist = (activity: string): string => {
  const line = activity.trim();
  // The server says "Running <command>"; an older or scripted line may be the bare command.
  const running = /^Running (.+)$/.exec(line) ?? BARE_COMMAND.exec(line);
  if (running !== null && running[1] !== undefined) {
    const command = running[1];
    if (/^git push\b/.test(command)) return "pushing";
    if (/^git commit\b/.test(command)) return "committing";
    if (/^gh pr\b/.test(command)) return "working on its PR";
    if (TEST_COMMAND.test(command)) return "running tests";
    if (/\b(lint|oxlint|eslint|fmt|format)\b/i.test(command)) return "linting";
    if (/\b(build|tsc|compile)\b/i.test(command)) return "building";
    if (/\b(install|add)\b/.test(command)) return "installing packages";
    return "running a command";
  }
  if (/^(Editing|Writing) /.test(line)) return "editing code";
  if (line.startsWith("Reading ")) return "reading code";
  if (/^(Finding|Searching for|Searching files|Listing files)/.test(line)) return "searching code";
  if (/^(Fetching|Searching the web)/.test(line)) return "reading the web";
  if (/^Updating the plan$/.test(line)) return "planning";
  if (/^Presenting the plan$/.test(line)) return "proposing a plan";
  if (/^Asking a question$/.test(line)) return "asking you";
  if (/^Starting a subagent$|^[\w-]+: /.test(line) && !line.startsWith("Using "))
    return "running a subagent";
  const using = /^Using ([\w-]+)/.exec(line);
  if (using !== null) return capWords(`using ${using[1]}`);
  return capWords(lowerFirst(line.replace(/…$/, "")));
};

/** A request the worker waits on the user for, in a now line's words. */
export const requestGist = (
  request: Pick<WorkerPendingRequest, "kind" | "summary">,
  command?: string | undefined,
): string => {
  if (request.kind === "question") return "asks you";
  if (request.kind === "plan") return "has a plan";
  // The ledger's summary of an approval reads "Bash: git push -u origin …".
  const words = (command ?? request.summary?.replace(/^[\w .-]{1,40}:\s+/, "") ?? "").trim();
  if (/^git push\b/.test(words)) return "wants to push";
  if (/^gh pr merge\b/.test(words)) return "wants to merge";
  if (command !== undefined && words !== "")
    return capWords(`wants to run ${words.split(/\s+/)[0]}`);
  return "wants approval";
};

/**
 * A worker's now line on its card: four words or fewer, from its facts alone (no model). A pending
 * request first, then a failure, the end of the road, the running tool call, a standing question
 * or block, its PR's checks, and last its latest report or the tool it stopped after.
 */
export const nowLineOf = (
  worker: Pick<
    WorkerLedgerEntry,
    | "state"
    | "status"
    | "pendingRequests"
    | "lastReport"
    | "reportStands"
    | "quiet"
    | "pr"
    | "userIntervened"
    | "compacting"
  >,
  /** The live activity line while it runs ("Running uv run pytest"). */
  activity?: string | undefined,
): string => {
  const line = (() => {
    const [request] = worker.pendingRequests;
    if (request !== undefined) return requestGist(request);
    const report = worker.lastReport;
    switch (worker.state) {
      case "error":
        return "stopped on an error";
      case "merged":
        return worker.pr === undefined ? "merged" : `merged as #${worker.pr.number}`;
      case "delivered":
        return "delivered";
      case "archived":
        return "archived";
    }
    if (worker.status === "running" || worker.status === "starting") {
      if (worker.compacting === true) return "compacting";
      // A running worker that reported a count since is better told by it than by "running tests".
      const counted = report === undefined ? undefined : reportGist(report.summary);
      if (
        counted?.startsWith("tests ") === true &&
        (activity === undefined || TEST_COMMAND.test(activity))
      )
        return counted;
      return activity === undefined ? "working" : activityGist(activity);
    }
    if (
      worker.state === "question" ||
      (worker.reportStands === true && report?.state === "question")
    )
      return "asked a question";
    if (worker.state === "blocked" || worker.reportStands === true) return "blocked";
    if (worker.userIntervened) return "you hold it";
    if (worker.pr !== undefined && (worker.pr.state === undefined || worker.pr.state === "open")) {
      const checks = checksOf(worker.pr.checks);
      if (checks === "failing") return "checks failing";
      if (checks === "pending") return "checks running";
      if (worker.state === "readyToMerge") return "ready to merge";
      return "in review";
    }
    if (worker.state === "briefed") return "briefed";
    if (report !== undefined)
      return report.state === "done" ? "reported done" : reportGist(report.summary);
    if (worker.quiet?.lastTool !== undefined) return `stopped after ${worker.quiet.lastTool}`;
    return "idle";
  })();
  return capWords(line);
};

// ---------------------------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------------------------

/** One of a worker's PRs as its card's chip shows it. */
export const FeatureCardPr = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  number: Schema.Int,
  /** Only an address a browser may open (`https://`). */
  url: Schema.optionalKey(Schema.String),
  /** Absent until its badge has been looked up. */
  state: Schema.optionalKey(Schema.Literals(["open", "merged", "closed"])),
  /** The required checks' rollup, when known. */
  checks: Schema.optionalKey(ChecksRollup),
});
export type FeatureCardPr = typeof FeatureCardPr.Type;

/** A worker's PRs in the order its card shows them: its bound one, its others, then other repos'. */
export { ledgerPrsOf } from "./ci-fix-ownership.ts";

/** A ledger PR as a card's chip. */
export const featureCardPrOf = (pr: WorkerPr): FeatureCardPr => {
  const checks = checksOf(pr.checks);
  return {
    repo: pr.repo,
    number: pr.number,
    ...(pr.url?.startsWith("https://") === true ? { url: pr.url } : {}),
    ...(pr.state === undefined ? {} : { state: pr.state }),
    ...(checks === undefined ? {} : { checks }),
  };
};

/** One worker's line on its feature's card. */
export const FeatureCardWorker = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  /** The project's name. */
  project: Schema.String,
  /** The model it runs on (`ModelRef.model`); absent when unknown. */
  model: Schema.optionalKey(Schema.String),
  /** Its ledger state, for views that say more than the station. */
  state: WorkerState,
  station: FeatureStation,
  /** Set when it failed: it stays at `station` rather than moving back. */
  flag: Schema.optionalKey(FeatureStationFlag),
  /** Four words or fewer (`nowLineOf`). */
  now: Schema.String,
  /** Its PRs, its own repo's first. */
  prs: Schema.Array(FeatureCardPr),
  /** Workers in the same project whose changed files intersect this one's (the ledger's advisory overlap). */
  overlapsWith: Schema.Array(ThreadId),
  /** The paths it shares with them, sorted, the first few only. */
  overlapFiles: Schema.Array(Schema.String),
});
export type FeatureCardWorker = typeof FeatureCardWorker.Type;

/** A feature's stage as its card shows it: somebody's word, not derived (`FeatureStage`). */
export const FeatureCardStage = Schema.Struct({
  plan: Schema.optionalKey(Schema.Array(Schema.String)),
  current: Schema.String.check(Schema.isMaxLength(FEATURE_STAGE_MAX)),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(FEATURE_STAGE_NOTE_MAX))),
});
export type FeatureCardStage = typeof FeatureCardStage.Type;

/** The longest helper summary a card carries. */
export const FEATURE_CARD_SUMMARY_MAX = 200;

/** The helper's one plain sentence on a card, for the card version it was written for. */
export const FeatureCardSummary = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(FEATURE_CARD_SUMMARY_MAX)),
  /** The card version it was written for; a later version drops it until it is written again. */
  version: Schema.Int,
});
export type FeatureCardSummary = typeof FeatureCardSummary.Type;

/** A brief of the feature held until a usage limit resets, as its card shows it. */
export const FeatureCardHeld = HeldBrief.mapFields(({ feature: _f, heldAt: _h, ...rest }) => rest);
export type FeatureCardHeld = typeof FeatureCardHeld.Type;

/**
 * One feature as the orchestrator's stream shows it: once, updated in place. `version` grows by one
 * whenever anything it shows changes, and a newer card replaces an older one wherever it is shown.
 */
export const FeatureCard = Schema.Struct({
  workspaceId: WorkspaceId,
  /** The feature's slug, the card's key within the workspace. */
  feature: Schema.String,
  group: Schema.optionalKey(Schema.String),
  stage: Schema.optionalKey(FeatureCardStage),
  /** The user paused it: its workers are stopped and nothing wakes, messages or spawns for it. */
  paused: Schema.optionalKey(Schema.Literal(true)),
  /** Its least advanced live worker's (`cardStationOf`). */
  station: FeatureStation,
  /** 1 for a feature's first card. */
  version: Schema.Int,
  workers: Schema.Array(FeatureCardWorker),
  /** Its low-priority briefs held until a usage limit resets, soonest first; absent with none. */
  held: Schema.optionalKey(Schema.Array(FeatureCardHeld)),
  /** Absent with helpers off, or until one is written for this version. */
  summary: Schema.optionalKey(FeatureCardSummary),
  /** Epoch ms the feature's first card was made: where it sits in the stream. */
  createdAt: Schema.Number,
  /** Epoch ms `version` last grew. */
  updatedAt: Schema.Number,
});
export type FeatureCard = typeof FeatureCard.Type;

/** A workspace's cards, oldest first (`orchestrator.featureCards`, `orchestrator.watchFeatureCards`). */
export const FeatureCards = Schema.Struct({
  workspaceId: WorkspaceId,
  cards: Schema.Array(FeatureCard),
});
export type FeatureCards = typeof FeatureCards.Type;

/**
 * Whether a view draws the card: it has a worker, or a brief held. One left with neither (its held
 * brief dropped before it spawned) stays in the list, so a client's older version of it, held
 * brief and all, is replaced, but is shown nowhere.
 */
export const cardShown = (card: Pick<FeatureCard, "workers" | "held">): boolean =>
  card.workers.length > 0 || (card.held?.length ?? 0) > 0;

/** The summary to show: only the one written for the card's current version. */
export const currentSummary = (card: FeatureCard): string | undefined =>
  card.summary !== undefined && card.summary.version === card.version
    ? card.summary.text
    : undefined;

/** Newer replaces older: the card with the higher version for each feature. */
export const newerCard = (a: FeatureCard | undefined, b: FeatureCard): FeatureCard =>
  a === undefined || b.version >= a.version ? b : a;

/**
 * `next` laid over `current`, card by card, the newer version winning: a response that arrives late
 * can't put an older card back. Returns `current` itself when nothing in it changes.
 */
export const mergeFeatureCards = (
  current: FeatureCards | undefined,
  next: FeatureCards,
): FeatureCards => {
  if (current === undefined || current.workspaceId !== next.workspaceId) return next;
  const byFeature = new Map(current.cards.map((card) => [card.feature, card]));
  let changed = false;
  for (const card of next.cards) {
    const before = byFeature.get(card.feature);
    const kept = newerCard(before, card);
    if (kept !== before) {
      // The same version may carry a summary written for it since.
      if (before === undefined || kept.version > before.version || kept.summary !== before.summary)
        changed = true;
      byFeature.set(card.feature, kept);
    }
  }
  if (!changed) return current;
  return {
    workspaceId: next.workspaceId,
    cards: [...byFeature.values()].toSorted(
      (a, b) =>
        a.createdAt - b.createdAt || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0),
    ),
  };
};

// ---------------------------------------------------------------------------------------------
// Versioning: newer replaces older
// ---------------------------------------------------------------------------------------------

/** What the service knows beside the ledger when it builds the cards. */
export interface FeatureCardFacts {
  readonly workspaceId: WorkspaceId;
  readonly features: ReadonlyArray<FeatureLedgerEntry>;
  /** Each worker's model (`Thread.model.model`). */
  readonly models: ReadonlyMap<ThreadId, string>;
  /** The live activity line of each busy worker. */
  readonly activity: ReadonlyMap<ThreadId, string>;
  /** Epoch ms each worker was spawned, which places a new card in the stream. */
  readonly spawnedAt: ReadonlyMap<ThreadId, number>;
  /** The ledger's held briefs (`OrchestratorLedger.held`); absent with none. */
  readonly held?: ReadonlyArray<HeldBrief> | undefined;
  readonly now: number;
}

/** A held brief as its feature's card shows it. */
const cardHeldOf = ({ feature: _feature, heldAt: _heldAt, ...rest }: HeldBrief): FeatureCardHeld =>
  rest;

const cardWorkerOf = (
  worker: WorkerLedgerEntry,
  previous: FeatureCardWorker | undefined,
  facts: FeatureCardFacts,
): FeatureCardWorker => {
  const model = facts.models.get(worker.threadId);
  const flag = stationFlag(worker);
  return {
    threadId: worker.threadId,
    title: worker.title,
    project: worker.project,
    ...(model === undefined ? {} : { model }),
    state: worker.state,
    station: stationOf(worker, previous?.station),
    ...(flag === undefined ? {} : { flag }),
    now: nowLineOf(worker, facts.activity.get(worker.threadId)),
    prs: ledgerPrsOf(worker).map(featureCardPrOf),
    overlapsWith: worker.overlapsWith,
    overlapFiles: worker.overlapFiles ?? [],
  };
};

/** Sorted-key JSON, so two cards that say the same thing compare equal however they were built. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, each: unknown) =>
    each !== null && typeof each === "object" && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : each,
  );

/** What a card shows, without what only says when or which version. */
const bodyOf = (card: FeatureCard): string => {
  const {
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    summary: _summary,
    ...body
  } = card;
  return canonical(body);
};

/** The card a feature's ledger entry makes now, given its previous card. */
export const featureCardOf = (
  feature: FeatureLedgerEntry,
  previous: FeatureCard | undefined,
  facts: FeatureCardFacts,
): FeatureCard => {
  const before = new Map(previous?.workers.map((worker) => [worker.threadId, worker]));
  const workers = feature.workers.map((worker) =>
    cardWorkerOf(worker, before.get(worker.threadId), facts),
  );
  const stage = feature.stage;
  const heldBriefs = (facts.held ?? []).filter((brief) => brief.feature === feature.feature);
  const held = heldBriefs.toSorted((a, b) => a.until - b.until).map(cardHeldOf);
  const spawned = [
    ...feature.workers.flatMap((worker) => {
      const at = facts.spawnedAt.get(worker.threadId);
      return at === undefined ? [] : [at];
    }),
    ...heldBriefs.map((brief) => brief.heldAt),
  ];
  const draft: FeatureCard = {
    workspaceId: facts.workspaceId,
    feature: feature.feature,
    ...(feature.group === undefined ? {} : { group: feature.group }),
    ...(stage === undefined
      ? {}
      : {
          stage: {
            ...(stage.plan === undefined ? {} : { plan: stage.plan }),
            current: stage.stage,
            ...(stage.note === undefined ? {} : { note: stage.note }),
          },
        }),
    ...(feature.paused === true ? { paused: true as const } : {}),
    station: cardStationOf(workers),
    version: 1,
    workers,
    ...(held.length === 0 ? {} : { held }),
    createdAt: previous?.createdAt ?? (spawned.length > 0 ? Math.min(...spawned) : facts.now),
    updatedAt: facts.now,
  };
  if (previous === undefined) return draft;
  if (bodyOf(draft) === bodyOf(previous)) return previous;
  return {
    ...draft,
    version: previous.version + 1,
    ...(previous.summary === undefined ? {} : { summary: previous.summary }),
  };
};

/**
 * The workspace's cards after the ledger moved: one per feature, the newer replacing the older.
 * A feature with only held briefs has a card of its own, at `briefed` with no workers. A card whose
 * feature left the ledger stays as it last was, its held briefs aside, which go once they are no
 * longer held. `changed` are the ones to persist.
 */
export const reconcileFeatureCards = (
  previous: ReadonlyArray<FeatureCard>,
  facts: FeatureCardFacts,
): { readonly cards: ReadonlyArray<FeatureCard>; readonly changed: ReadonlyArray<FeatureCard> } => {
  const byFeature = new Map(previous.map((card) => [card.feature, card]));
  const changed: Array<FeatureCard> = [];
  const inLedger = new Set(facts.features.map((feature) => feature.feature));
  const heldOnly = new Set(
    (facts.held ?? []).flatMap((brief) => (inLedger.has(brief.feature) ? [] : [brief.feature])),
  );
  // A card left with held briefs no longer held: kept as it was, without them.
  for (const card of previous) {
    if (card.held === undefined || inLedger.has(card.feature) || heldOnly.has(card.feature)) {
      continue;
    }
    const { held: _held, summary: _summary, ...rest } = card;
    const next: FeatureCard = { ...rest, version: card.version + 1, updatedAt: facts.now };
    changed.push(next);
    byFeature.set(card.feature, next);
  }
  const features: ReadonlyArray<FeatureLedgerEntry> = [
    ...facts.features,
    ...[...heldOnly].map((feature): FeatureLedgerEntry => ({
      feature,
      state: "briefed",
      workers: [],
    })),
  ];
  for (const feature of features) {
    const before = byFeature.get(feature.feature);
    const card = featureCardOf(feature, before, facts);
    if (card !== before) {
      changed.push(card);
      byFeature.set(feature.feature, card);
    }
  }
  const cards = [...byFeature.values()].toSorted(
    (a, b) =>
      a.createdAt - b.createdAt || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0),
  );
  return { cards, changed };
};

/** Same cards, same text: what the watch compares before it sends. */
export const featureCardsText = (cards: ReadonlyArray<FeatureCard>): string => canonical(cards);

// ---------------------------------------------------------------------------------------------
// The event budget
// ---------------------------------------------------------------------------------------------

/**
 * What the orchestration can tell the stream about. Worker state moves are the digest's
 * `DigestChange.to`; the rest are `orchestration_events` kinds and PR facts.
 */
export const StreamEventKind = Schema.Literals([
  // Worker state moves (DigestChange.to)
  "briefed",
  "working",
  "needsUser",
  "question",
  "blocked",
  "done",
  "inReview",
  "readyToMerge",
  "delivered",
  "merged",
  "error",
  "archived",
  // PR facts
  "checksFailing",
  "checksPassing",
  // orchestration_events kinds
  "spawn",
  "stage",
  "group",
  "join",
  "repoAdded",
  "released",
  "report",
  "wake",
  "message",
  "answer",
  "handoff",
  "handoffRequested",
  "handoffAbandoned",
  "orchestratorEdits",
  "pause",
  "resume",
]);
export type StreamEventKind = typeof StreamEventKind.Type;

/** Each event updates a card, becomes one stream line, or stays silent. */
export type StreamBudget = "card" | "line" | "silent";

/**
 * The event budget: merges, failures and asks speak; wakes and stage moves never reach the stream.
 */
export const EVENT_BUDGET: Readonly<Record<StreamEventKind, StreamBudget>> = {
  briefed: "card",
  working: "card",
  needsUser: "line",
  question: "line",
  blocked: "line",
  done: "card",
  inReview: "card",
  readyToMerge: "card",
  delivered: "line",
  merged: "line",
  error: "line",
  archived: "card",
  checksFailing: "line",
  checksPassing: "card",
  spawn: "card",
  stage: "card",
  group: "card",
  join: "card",
  repoAdded: "card",
  released: "card",
  report: "card",
  wake: "silent",
  message: "silent",
  answer: "silent",
  handoff: "silent",
  handoffRequested: "silent",
  handoffAbandoned: "silent",
  orchestratorEdits: "silent",
  pause: "line",
  resume: "silent",
};

/** What a stream line is about, which decides its icon and tone. */
export type StreamLineKind = "merged" | "delivered" | "failed" | "ask" | "paused";

/** One line in the orchestrator's stream: something that spoke. */
export interface StreamLine {
  /** Stable within its digest, for React keys. */
  readonly key: string;
  readonly kind: StreamLineKind;
  readonly feature: string;
  readonly threadId?: ThreadId | undefined;
  /** The worker's title, which the line links. */
  readonly title?: string | undefined;
  /** The PR the line names, linked. */
  readonly pr?: FeatureCardPr | undefined;
  /** A few words after the names: "merged", "checks fail", "asks you". */
  readonly words: string;
}

const LINE_OF_STATE: Partial<Record<StreamEventKind, readonly [StreamLineKind, string]>> = {
  merged: ["merged", "merged"],
  delivered: ["delivered", "delivered"],
  error: ["failed", "stopped on an error"],
  blocked: ["failed", "is blocked"],
  needsUser: ["ask", "waits on you"],
  question: ["ask", "asks you"],
};

type DigestFacts = Pick<OrchestrationDigest, "changes" | "features" | "paused">;

/**
 * The stream lines one digest speaks, given the digest before it: each worker state move the
 * budget calls a line, PR checks that turned failing, and a pause that is new. Everything else the
 * digest carries updates a card or stays silent.
 */
export const streamLinesOf = (
  digest: DigestFacts,
  previous: DigestFacts | undefined,
): ReadonlyArray<StreamLine> => {
  const lines: Array<StreamLine> = [];
  const workers = new Map(
    digest.features.flatMap((feature) =>
      feature.workers.map((worker) => [worker.threadId, worker]),
    ),
  );
  const before = new Map(
    (previous?.features ?? []).flatMap((feature) =>
      feature.workers.map((worker) => [worker.threadId, worker]),
    ),
  );
  const seen = new Set<string>();
  for (const change of digest.changes) {
    if (change.from === change.to || EVENT_BUDGET[change.to] !== "line") continue;
    const line = LINE_OF_STATE[change.to];
    if (line === undefined) continue;
    const worker = workers.get(change.threadId);
    const pr =
      change.to === "merged" && worker !== undefined
        ? ledgerPrsOf(worker).find((each) => each.state === "merged")
        : undefined;
    const key = `${change.threadId}:${change.to}`;
    seen.add(key);
    lines.push({
      key,
      kind: line[0],
      feature: change.feature,
      threadId: change.threadId,
      title: change.title,
      ...(pr === undefined ? {} : { pr: featureCardPrOf(pr) }),
      words: line[1],
    });
  }
  const ownedCi = ciFixOwnedPrs(workers.values());
  const priorOwnedCi = ciFixOwnedPrs(before.values());
  // Checks turning failing or losing their last owner speak once.
  if (previous !== undefined && EVENT_BUDGET.checksFailing === "line") {
    for (const [threadId, worker] of workers) {
      const was = before.get(threadId);
      if (was === undefined) continue;
      for (const pr of ledgerPrsOf(worker)) {
        if (checksOf(pr.checks) !== "failing" || ownedCi.has(ciFixPrKey(pr))) continue;
        const prior = ledgerPrsOf(was).find(
          (each) => each.repo === pr.repo && each.number === pr.number,
        );
        if (
          prior !== undefined &&
          checksOf(prior.checks) === "failing" &&
          !priorOwnedCi.has(ciFixPrKey(prior))
        )
          continue;
        if (prior === undefined && was.state === worker.state) continue;
        const key = `${threadId}:checks:${pr.repo}#${pr.number}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lines.push({
          key,
          kind: "failed",
          feature: worker.feature,
          threadId,
          title: worker.title,
          pr: featureCardPrOf(pr),
          words: "checks fail",
        });
      }
    }
  }
  if (
    digest.paused !== undefined &&
    previous?.paused === undefined &&
    EVENT_BUDGET.pause === "line"
  ) {
    lines.push({ key: "paused", kind: "paused", feature: "", words: "orchestrator paused" });
  }
  return lines;
};

// ---------------------------------------------------------------------------------------------
// Since you left
// ---------------------------------------------------------------------------------------------

/**
 * What changed while the user was away, for one card at the top of the stream when they come
 * back. Folded from the digests the orchestrator was given meanwhile (the same facts as its
 * `away` digest), never derived again from the ledger.
 */
export interface SinceYouLeft {
  /** Epoch ms of the first and the last digest folded in. */
  readonly from: number;
  readonly to: number;
  readonly merged: ReadonlyArray<StreamLine>;
  readonly failed: ReadonlyArray<StreamLine>;
  /** Failed workers that came back since (`error` then working on). */
  readonly recovered: ReadonlyArray<ThreadId>;
  /** What still waits on the user, from the latest digest. */
  readonly asksWaiting: number;
  /** Events that updated a card or stayed silent, counted. */
  readonly quiet: number;
}

/** A digest with the epoch ms it was delivered. */
export interface DeliveredDigest {
  readonly digest: OrchestrationDigest;
  readonly at: number;
}

const changeIsAsk = (change: DigestChange) => change.to === "needsUser" || change.to === "question";

/**
 * Folds the digests delivered after `since` (the user's `lastViewedAt` on the orchestrator) into
 * a since-you-left summary; `undefined` when nothing in them speaks and nothing waits.
 */
export const sinceYouLeftOf = (
  digests: ReadonlyArray<DeliveredDigest>,
  since: number | undefined,
): SinceYouLeft | undefined => {
  if (since === undefined) return undefined;
  const ordered = digests.toSorted((a, b) => a.at - b.at);
  // A redelivery carries the same generation; it is folded once.
  const generations = new Set<number>();
  let previous: OrchestrationDigest | undefined;
  const merged: Array<StreamLine> = [];
  const failed: Array<StreamLine> = [];
  const failedAt = new Map<ThreadId, number>();
  const recovered = new Set<ThreadId>();
  let quiet = 0;
  let latest: OrchestrationDigest | undefined;
  let from: number | undefined;
  let to = since;
  for (const { digest, at } of ordered) {
    if (at <= since) {
      previous = digest;
      continue;
    }
    if (digest.variant === "boot" || digest.variant === "checkpoint") {
      previous = digest;
      continue;
    }
    if (generations.has(digest.generation)) continue;
    generations.add(digest.generation);
    from ??= at;
    to = at;
    latest = digest;
    const lines = streamLinesOf(digest, previous);
    for (const line of lines) {
      if (line.kind === "merged" || line.kind === "delivered") merged.push(line);
      else if (line.kind === "failed" || line.kind === "paused") {
        failed.push(line);
        if (line.threadId !== undefined) failedAt.set(line.threadId, at);
      }
    }
    for (const change of digest.changes) {
      if (
        change.from === "error" &&
        change.to !== "error" &&
        change.to !== "archived" &&
        failedAt.has(change.threadId)
      )
        recovered.add(change.threadId);
    }
    quiet +=
      digest.changes.filter((change) => !changeIsAsk(change) && EVENT_BUDGET[change.to] !== "line")
        .length +
      digest.reasons.length +
      digest.reports.length;
    previous = digest;
  }
  if (latest === undefined || from === undefined) return undefined;
  const pending = latest.features.reduce(
    (n, feature) => n + feature.workers.reduce((m, worker) => m + worker.pendingRequests.length, 0),
    0,
  );
  const asksWaiting = pending + (latest.waiting?.open ?? 0);
  if (merged.length === 0 && failed.length === 0 && asksWaiting === 0) return undefined;
  return { from, to, merged, failed, recovered: [...recovered], asksWaiting, quiet };
};

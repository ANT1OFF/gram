// Pausing new workers near a subscription limit (One thread buildout, "Usage, not dollars"): which
// limits a workspace runs against, which of them stand at its threshold, and what the user chose.

import {
  limitCurrent,
  limitExpiresAt,
  type HeldBrief,
  type LimitRecord,
  type LimitUse,
  type ModelRef,
  type OrchestratorCharter,
} from "@gram/contracts";
import type { LimitHold, StoredHeldBrief } from "./outbox.ts";
import { featureSlug } from "./rules.ts";

const WINDOW_OF: Readonly<Record<string, LimitUse["window"]>> = {
  five_hour: "fiveHour",
  seven_day: "weekly",
};

const AGENT_NAME: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex" };
const WINDOW_NAME: Readonly<Record<string, string>> = { five_hour: "5-hour", seven_day: "weekly" };

/** "Claude's 5-hour limit". */
export const limitName = (
  limit: Pick<LimitRecord | LimitHold | StoredHeldBrief, "agent" | "window">,
): string =>
  `${AGENT_NAME[limit.agent] ?? limit.agent}'s ${WINDOW_NAME[limit.window] ?? limit.window} limit`;

/** "Claude". */
export const limitAgentName = (agent: string): string => AGENT_NAME[agent] ?? agent;

/** A share as the meter shows it: a whole percent, and 100 only once it is all used. */
export const usedPct = (utilization: number): number =>
  utilization >= 1 ? 100 : Math.min(99, Math.round(utilization * 100));

/**
 * The agents whose own logins the workspace's threads run on: the orchestrator's and each roster
 * entry's that names no gateway profile. A gateway's limits are its own, not the subscription's.
 */
export const subscriptionAgents = (
  charter: Pick<OrchestratorCharter, "workerModels">,
  orchestrator: Pick<ModelRef, "agent" | "profileId"> | undefined,
): ReadonlySet<string> =>
  new Set(
    [...(orchestrator === undefined ? [] : [orchestrator]), ...(charter.workerModels ?? [])]
      .filter((model) => model.profileId === undefined)
      .map((model) => model.agent),
  );

/**
 * The subscription readings of `agents` still current at `now`, of the windows the meter shows,
 * tightest first: the higher share, then the sooner reset.
 */
export const subscriptionLimits = (
  records: ReadonlyArray<LimitRecord>,
  agents: ReadonlySet<string>,
  now: number,
): ReadonlyArray<LimitRecord> =>
  records
    .filter(
      (record) =>
        record.profileId === undefined &&
        agents.has(record.agent) &&
        WINDOW_OF[record.window] !== undefined &&
        limitCurrent(record, now),
    )
    .toSorted(
      (a, b) =>
        b.utilization - a.utilization ||
        (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity) ||
        a.window.localeCompare(b.window),
    );

/** Whether `record` stands at `pauseAtPct` or past it: a rejection always does. */
export const atThreshold = (record: LimitRecord, pauseAtPct: number): boolean =>
  record.status === "rejected" || usedPct(record.utilization) >= pauseAtPct;

/** The holds whose windows haven't reset by `now`. */
export const activeHolds = (
  holds: ReadonlyArray<LimitHold> | undefined,
  now: number,
): ReadonlyArray<LimitHold> => (holds ?? []).filter((hold) => hold.until > now);

/** What the user chose about `record`'s window, while that window lasts. */
export const holdOf = (
  holds: ReadonlyArray<LimitHold> | undefined,
  record: Pick<LimitRecord, "agent" | "window">,
  now: number,
): LimitHold | undefined =>
  activeHolds(holds, now).find(
    (hold) => hold.agent === record.agent && hold.window === record.window,
  );

/** The limits as the ledger and the digest carry them, tightest first. */
export const limitUses = (
  limits: ReadonlyArray<LimitRecord>,
  holds: ReadonlyArray<LimitHold> | undefined,
  now: number,
): ReadonlyArray<LimitUse> =>
  limits.flatMap((record) => {
    const window = WINDOW_OF[record.window];
    if (window === undefined) return [];
    const hold = holdOf(holds, record, now);
    return [
      {
        agent: record.agent,
        window,
        usedPct: usedPct(record.utilization),
        ...(record.resetsAt === undefined ? {} : { resetsAt: record.resetsAt }),
        ...(hold === undefined ? {} : { hold: hold.decision }),
      },
    ];
  });

/** The note the digest after a paused window's reset carries. */
export const resumeNote = (hold: LimitHold): string =>
  `${limitName(hold)} has reset, so new ${limitAgentName(hold.agent)} workers can be spawned again. Pick up the briefs you held back.`;

// ---------------------------------------------------------------------------------------------
// Holding low-priority briefs until a limit resets
// ---------------------------------------------------------------------------------------------

/**
 * The share at which a workspace holds low-priority briefs: its pause threshold, which the user
 * opts into. Without one, only a limit the agent refused a turn on holds them, never a share: a
 * full window can go on, on credits.
 */
export const holdAtPct = (
  charter: Pick<OrchestratorCharter, "pauseAtLimitPct">,
): number | undefined => charter.pauseAtLimitPct;

/**
 * Of `limits` (one agent's, `subscriptionLimits`), the one a low-priority brief waits on: of those
 * rejected, or at `pct` when the workspace set one, the one that resets last, since the brief
 * can't start before it does.
 */
export const holdingLimit = (
  limits: ReadonlyArray<LimitRecord>,
  pct: number | undefined,
): LimitRecord | undefined =>
  limits
    .filter((limit) => (pct === undefined ? limit.status === "rejected" : atThreshold(limit, pct)))
    .toSorted((a, b) => limitExpiresAt(b) - limitExpiresAt(a))[0];

/** A stored held brief as the ledger and the cards show it. */
export const heldBriefOf = (stored: StoredHeldBrief): HeldBrief => ({
  id: stored.id,
  ...(stored.breaker === undefined ? {} : { reason: heldWords(stored) }),
  // Keyed as the worker it becomes is, so its card is the feature's card.
  feature: featureSlug(stored.input.feature) ?? stored.input.feature,
  title: stored.input.title,
  project: stored.projectName,
  agent: stored.agent,
  window: WINDOW_OF[stored.window] ?? "fiveHour",
  usedPct: stored.usedPct,
  until: stored.until,
  heldAt: stored.heldAt,
  ...(stored.waitsForSlot === true ? { waitsForSlot: true as const } : {}),
  ...(stored.retryAt === undefined || stored.waitsForSlot === true
    ? {}
    : { retryAt: stored.retryAt }),
});

/** How long a held brief waits before it is tried again: a slot taken, or a refusal for now. */
export const HELD_RETRY_MS = 2 * 60_000;
/** Releases refused for now (rate limited, paused, a failing git) before a held brief is dropped. */
export const HELD_RETRIES_MAX = 5;

/** Refusals that pass on their own: the brief is tried again rather than dropped. */
const PASSING_REFUSALS: ReadonlySet<string> = new Set([
  "rate",
  "paused",
  "feature_paused",
  "no_authority",
]);

/**
 * Whether a spawn's refusal passes on its own: a coded one in `PASSING_REFUSALS`, or one with no
 * code (a git or filesystem failure). A coded refusal of anything else (a bad feature name, a model
 * no longer allowed) would refuse again.
 */
export const refusalPasses = (message: string): boolean => {
  const code = /^([a-z_]+): /.exec(message)?.[1];
  return code === undefined || PASSING_REFUSALS.has(code);
};

/** The digest's note when a held brief's limit reset but every worker slot is taken. */
export const slotWaitNote = (stored: StoredHeldBrief, live: number, cap: number): string =>
  `${stored.breaker === undefined ? `${limitName(stored)} has reset` : "The provider recovery hold is ready"}, but ${live} workers are live and the charter allows ${cap}, so the held brief “${stored.input.title}” (${stored.input.feature}) waits for a worker to finish and starts on its own then.`;

/** "2026-10-15T16:00Z": a time as the orchestrator reads it. */
const utcMinute = (at: number): string => `${new Date(at).toISOString().slice(0, 16)}Z`;

/** What `spawn_worker` tells the orchestrator about a brief it held. */
export const heldWords = (stored: StoredHeldBrief): string =>
  stored.breaker !== undefined
    ? `Held, not spawned: ${stored.breaker.model.agent}:${stored.breaker.model.model} failed with ${stored.breaker.kind} without output at ${new Date(stored.breaker.at).toISOString()}. A turn producing output clears this hold; after ${utcMinute(stored.until)} one held worker probes recovery. Manage this brief with manage_held_spawn; don't spawn it again.`
    : `Held, not spawned: ${limitName(stored)} is at ${stored.usedPct}% and this brief is low priority. It starts on its own when the limit resets (${utcMinute(stored.until)}) or a turn on ${limitAgentName(stored.agent)} goes through, or sooner if the user releases it; a digest says when it does. Don't spawn it again.`;

/** The digest's note once a held brief started. */
export const releasedNote = (stored: StoredHeldBrief, threadId: string, byUser: boolean): string =>
  `The held brief “${stored.input.title}” (${stored.input.feature}) was spawned ${byUser ? "by the user, before the reset" : stored.breaker === undefined ? `as ${limitName(stored)} reset` : "after the provider recovery hold"}: [${stored.input.title}](#${threadId}).`;

/** The digest's note when a held brief couldn't start at the reset. */
export const releaseFailedNote = (stored: StoredHeldBrief, why: string): string =>
  `The held brief “${stored.input.title}” (${stored.input.feature}) couldn't be spawned at the reset of ${stored.breaker === undefined ? limitName(stored) : "the provider recovery hold"}, so it is dropped: ${why.trim().replace(/\.+$/, "")}. Spawn it again if it is still wanted.`;

// ---------------------------------------------------------------------------------------------
// Offering another worker model at a limit (`routeAtLimit`)
// ---------------------------------------------------------------------------------------------
// Routing never reads a meter's share. It follows what actually stops a spawn: an account the
// agent's own CLI refused turns on (a rejected window; a share, even a full one, never counts,
// since credits can carry on past it), and
// the hold and pause gates, whatever makes those fire.

/**
 * What stopped a spawn: its account is at its limit, so its worker would only wait in its queue
 * (`queued`); the hold gate held its brief (`held`); or the pause gate refused it (`paused`).
 */
export type LimitStop = "queued" | "held" | "paused";

/**
 * Whether `record` says its account is at its limit now: the CLI refused turns on it. A full
 * window isn't, since turns can go on past it on credits, as the hold gate reads it too.
 */
const atItsLimit = (record: Pick<LimitRecord, "status">): boolean => record.status === "rejected";

/**
 * Of `limits` (one agent's, `subscriptionLimits`), the one its account is at, if any: the one that
 * resets last, since nothing on the account runs before it does.
 */
export const limitReached = (limits: ReadonlyArray<LimitRecord>): LimitRecord | undefined =>
  limits.filter(atItsLimit).toSorted((a, b) => limitExpiresAt(b) - limitExpiresAt(a))[0];

/**
 * Whether new workers of `agent`'s own login are stopped now: it is at its limit, or the user
 * paused new workers on one of its windows. What a route offer leaves out.
 */
export const agentStopped = (
  limits: ReadonlyArray<LimitRecord>,
  holds: ReadonlyArray<LimitHold> | undefined,
  agent: string,
  now: number,
): boolean =>
  limitReached(limits) !== undefined ||
  activeHolds(holds, now).some((hold) => hold.agent === agent && hold.decision === "paused");

/** A worker model the route offer lists, with the user's note on it. */
export interface RouteAlternative {
  /** As `spawn_worker.model` takes it: `agent:model`. */
  readonly model: string;
  readonly useFor?: string;
  /** It runs through a gateway profile, whose limits aren't the subscription's. */
  readonly gateway?: true;
}

/** What `spawn_worker` returns instead of spawning when it offers other models (`routeAtLimit`). */
export interface RouteOffer {
  readonly routeOffer: true;
  readonly feature: string;
  readonly title: string;
  /** The model it would have run on, `agent:model`. */
  readonly model: string;
  readonly wouldBe: "queued" | "paused";
  readonly alternatives: ReadonlyArray<RouteAlternative>;
  readonly note: string;
}

const CHOOSE =
  "This workspace offers another worker model at a limit, so the choice is yours: pick one of `alternatives` whose user note fits this brief, never one whose note rules this kind of work out,";

/** Why a spawn on `model` wasn't made because its account is at `limit`. */
export const reachedWords = (limit: LimitRecord, model: string): string =>
  `${limitName(limit)} is reached${limit.resetsAt === undefined ? "" : ` until ${utcMinute(limit.resetsAt)}`}, so a worker on ${model} would only wait in its queue.`;

/**
 * The route offer's choice for the orchestrator, after what stopped the spawn. A held brief is
 * retargeted (`manage_held_spawn`); a spawn that wasn't made is called again.
 */
export const routeChoiceWords = (input: {
  readonly stop: LimitStop;
  readonly model: string;
  readonly heldId?: string | undefined;
}): string =>
  input.stop === "held"
    ? `${CHOOSE} and call manage_held_spawn with action "retarget", id ${input.heldId} and that \`model\` to start it there; or leave it held. Tell the user which model the worker runs on and why.`
    : `${CHOOSE} and call spawn_worker again with the same input and that \`model\`; or with \`atLimit: "stay"\` to keep ${input.model} and let the limit take its course. Tell the user which model the worker runs on and why.`;

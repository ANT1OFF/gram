// Moving a thread, a worker or the orchestrator to the other agent ("Continue in Codex…"): whether
// it's offered, why it's greyed, what the sheet preselects, and what its lines say. The server makes
// the same refusals (`agent-switch.ts`, and the orchestrator's `handoff.ts`) and has the last word;
// these only keep the UI from offering what it would refuse.

import {
  aboveHigh,
  clampEffort,
  effectiveCheckout,
  findListed,
  isLocalHost,
  RECOMMENDED,
  resolveTier,
  TIERS,
  type AgentKind,
  type AgentModel,
  type Handoff,
  type LaunchChecks,
  type ModelRef,
  type PermissionMode,
  type ReasoningVariant,
  type ThreadSummary,
  isTierAgent,
} from "@gram/contracts";

import { AGENT_LABEL } from "@/agents/agent-label";
import { OLDER_SERVER } from "@/api/use-serves";
import { isOlderVersion } from "@/launch-checks/issues";
import { formatClockTime } from "@/lib/time";

/** What the user calls each agent: "Continue in Claude Code". */
const AGENT_NAMES = AGENT_LABEL;

/** The agent as its own words name it in a sentence: "A note from Claude". */
export const AGENT_SHORT: Readonly<Record<AgentKind, string>> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok Build",
  antigravity: "Antigravity",
};

export const otherAgent = (agent: AgentKind): AgentKind =>
  agent === "claude" ? "codex" : "claude";

/** The value of another agent's model in the chip's list, so a pick there is told apart. */
export const SWITCH_PREFIX = "continue-in:";

/** "Continue in Codex: new session with a handoff", the other agent's group heading on hover. */
export const continueHint = (to: AgentKind): string =>
  `Continue in ${AGENT_NAMES[to]}: new session with a handoff`;

/** The menu item's and the sheet's words. */
export const continueLabel = (to: AgentKind): string => `Continue in ${AGENT_NAMES[to]}`;

/** The Codex CLI that has its own Auto reviewer (`CODEX_AUTO_REVIEW_VERSION`). */
export const CODEX_AUTO_VERSION = "0.166.0";

/**
 * Whether the switch is offered on this thread, and if so to which agent and, when it can't move
 * now, why: the server's words. Where this session can't carry over at all (OpenCode's, which can't
 * stop and reopen a session for a switch; on Windows; on a gateway account; on another machine) it
 * is offered as `fresh`: a fresh session on the other agent in the same thread, which reads the
 * thread's recent turns (`thread.startFreshOn`, the orchestrator's handoff with a model). Not offered
 * while the other CLI isn't installed, so Gram with one harness shows nothing new.
 */
export type SwitchOffer =
  | { readonly offered: false }
  | {
      readonly offered: true;
      readonly to: AgentKind;
      readonly refusal?: string;
      /** Why this session can't carry over, so the move is a fresh session; absent for a switch. */
      readonly fresh?: string;
    };

/**
 * The launch checks found `agent`'s CLI. A headless server looks for none on its own machine, so
 * its joined machines' model listing says instead.
 */
export const installed = (checks: LaunchChecks | undefined, agent: AgentKind): boolean =>
  checks?.headless === true || checks?.tools.find((tool) => tool.tool === agent)?.found === true;

const RUNS_NOW: ReadonlySet<ThreadSummary["status"]> = new Set(["idle", "cold", "error"]);

/** Why this thread's session can't carry over to `to` wherever it is, in the user's words. */
const noCarryOver = (
  thread: ThreadSummary["thread"],
  to: AgentKind,
  platform: string | undefined,
): string | undefined => {
  const name = AGENT_NAMES[to];
  if (thread.model.agent === "opencode") return "OpenCode can't hand a session to another agent.";
  if (thread.model.agent === "grok") return "Grok Build can't hand a session to another agent.";
  if (thread.model.agent === "antigravity")
    return "Antigravity can't hand a session to another agent.";
  if (platform === "win32") return "A session can't be handed over on Windows.";
  if (thread.model.profileId !== undefined)
    return "This session runs on a gateway account, which a switch doesn't move.";
  if (!isLocalHost(effectiveCheckout(thread)))
    return `This thread's machine can't hand its session to ${name}.`;
  return undefined;
};

export const switchOffer = (input: {
  readonly summary: Pick<ThreadSummary, "thread" | "status" | "pendingRequests" | "background">;
  readonly checks: LaunchChecks | undefined;
  readonly platform?: string | undefined;
  /**
   * Whether the other agent lists models to continue on. Its CLI found but listing none, and not
   * signed out, it has nothing to offer.
   */
  readonly listed: boolean;
  /**
   * Why the other agent lists nothing, once its listing has settled (`unlistedReason`): the entry
   * is then offered greyed with these words rather than hidden. Absent while the listing runs.
   */
  readonly unlisted?: string | undefined;
  /** Whether the server serves `thread.startFreshOn`, which a worker's fresh session needs. */
  readonly servesFresh?: boolean;
}): SwitchOffer => {
  const { summary, checks } = input;
  const { thread } = summary;
  // An orchestrator's switch under way names where it is going, so its sheet shows how it stands.
  const to =
    thread.role === "orchestrator" && thread.sessionSwitch !== undefined
      ? thread.sessionSwitch.target.agent
      : otherAgent(thread.model.agent);
  if (!installed(checks, to)) return { offered: false };
  const signedOut = (to === "codex" ? checks?.codexSignIn : checks?.claudeSignIn) === "notSignedIn";
  const unlisted = input.listed || signedOut ? undefined : input.unlisted;
  if (!input.listed && !signedOut && unlisted === undefined) return { offered: false };
  const fresh =
    thread.sessionSwitch === undefined ? noCarryOver(thread, to, input.platform) : undefined;
  const refusal =
    unlisted ??
    (fresh !== undefined && thread.role !== "orchestrator" && input.servesFresh === false
      ? OLDER_SERVER
      : refusalOf(summary, to, checks!, fresh !== undefined));
  return {
    offered: true,
    to,
    ...(refusal === undefined ? {} : { refusal }),
    ...(fresh === undefined ? {} : { fresh }),
  };
};

/**
 * Why `to` lists no models to continue on, from its settled listing: the server can't run it at all
 * (no adapter), its listing failed, or it listed none. The server refuses a switch to a model its
 * CLI doesn't list (`checkSwitchTarget`), so these grey the entry; none of them is a sign-in, which
 * the launch checks say on their own.
 */
export const unlistedReason = (to: AgentKind, error: unknown): string => {
  const name = AGENT_NAMES[to];
  if (error === undefined || error === null)
    return `${name} lists no models here. Check ${name} in Settings → Agents.`;
  const tag = typeof error === "object" ? Reflect.get(error, "_tag") : undefined;
  const reason = typeof error === "object" ? Reflect.get(error, "reason") : undefined;
  if (tag === "AgentUnavailable" && reason === undefined)
    return `${name} isn't available here, so this thread can't move to it.`;
  const message = typeof error === "object" ? Reflect.get(error, "message") : undefined;
  return typeof message === "string" && message !== ""
    ? `${name}'s models couldn't be listed: ${message}`
    : `${name}'s models couldn't be listed. Check ${name} in Settings → Agents.`;
};

const refusalOf = (
  summary: Pick<ThreadSummary, "thread" | "status" | "pendingRequests" | "background">,
  to: AgentKind,
  checks: LaunchChecks,
  /** A fresh session: what only a carry-over asks of the session doesn't apply. */
  fresh: boolean,
): string | undefined => {
  const { thread } = summary;
  const from = AGENT_SHORT[thread.model.agent];
  const name = AGENT_NAMES[to];
  if (thread.role === "orchestrator") {
    // Its switch waits for its work and questions to finish (the checkpoint), and one under way
    // opens the sheet on how it stands, with Cancel or Retry.
    if (thread.sessionSwitch !== undefined) return undefined;
  } else {
    if (thread.sessionSwitch !== undefined || !RUNS_NOW.has(summary.status))
      return fresh
        ? "Wait for this turn to finish, or stop it, then start fresh."
        : "Wait for this turn to finish, or stop it, then switch.";
    if (summary.pendingRequests.length > 0)
      return `Answer the open approval first. It can't move to ${name}.`;
    if ((summary.background?.length ?? 0) > 0) return `${from} still has background work running.`;
  }
  if (!fresh && thread.model.profileId !== undefined)
    return "Switching uses the CLI's own sign-in; it doesn't move gateway accounts.";
  const signIn = to === "codex" ? checks.codexSignIn : checks.claudeSignIn;
  if (signIn === "notSignedIn") return `Sign in to ${name} in Settings → Agents.`;
  if (thread.parked)
    return fresh
      ? "Unarchive this thread before starting it fresh."
      : "Unarchive this thread before switching it.";
  if (!fresh && !isLocalHost(effectiveCheckout(thread)))
    return `${name} can't run on this thread's machine yet.`;
  if (
    thread.forkedFrom !== undefined &&
    (fresh || thread.agentSessionId === undefined || thread.agentSessionUnused === true)
  )
    return fresh
      ? "A fork can't start fresh; start a new thread instead."
      : "Send once in this fork first.";
  return undefined;
};

/** "Start fresh in Claude Code: new session with the recent turns", for the chip's group heading. */
export const freshHint = (to: AgentKind): string =>
  `Start fresh in ${AGENT_NAMES[to]}: new session with the recent turns`;

/**
 * The other agent's heading in the composer's model list. A pick there moves the thread, so it says
 * so beside the mark (`words`); when it can't move now, the words shorten to the move's name and the
 * reason follows on a line under them (`note`), which is also the mark's own label.
 */
export const switchGroupHead = (
  offer: SwitchOffer,
): { hint: string; words: string; note?: string } => {
  if (!offer.offered) return { hint: "", words: "" };
  if (offer.refusal === undefined) {
    const words = offer.fresh === undefined ? continueHint(offer.to) : freshHint(offer.to);
    return { hint: words, words };
  }
  const words = offer.fresh === undefined ? continueLabel(offer.to) : freshLabel(offer.to);
  return { hint: offer.refusal, words, note: offer.refusal };
};

/** The menu item's and the sheet's words for a fresh session on `to`. */
export const freshLabel = (to: AgentKind): string => `Start fresh in ${AGENT_NAMES[to]}`;

/** What a thread's fresh session gets, and what stays where it was. */
export const FRESH_CARRIES_LINE =
  "The recent turns, read from this thread's transcript. The branch, checkout and PR stay as they are.";

/** Where the conversation goes, for a fresh session. */
export const FRESH_STAYS_LINE = "This conversation stays in the thread, above a divider.";

/** What an orchestrator's fresh session gets. */
export const FRESH_ORCHESTRATOR_LINE =
  "Memory, the charter and the ledger carry over. Workers keep running.";

/**
 * Limit mode, as the server decides it (`noteModeOf`): the old agent can't take a note turn, being
 * out of usage by its own report or having failed its last turn, so the new agent writes the note.
 * `until` is when the limit resets, when the report said.
 */
export type SwitchLimit =
  | { readonly reason: "usage"; readonly until?: number }
  | { readonly reason: "failed" };

export const switchLimitOf = (
  summary: Pick<ThreadSummary, "thread" | "status">,
): SwitchLimit | undefined => {
  const { thread } = summary;
  const wait = thread.limitWait;
  if (wait !== undefined && wait.cleared === undefined) {
    const until = wait.resetsAt ?? wait.resumeAt;
    return { reason: "usage", until };
  }
  if (thread.lastError !== undefined || summary.status === "error") return { reason: "failed" };
  return undefined;
};

/** 24-hour "15:00". */
const clockTime = (at: number): string => formatClockTime(at);

/** The sheet's limit-mode line, first among its lines. */
export const limitLine = (limit: SwitchLimit, from: AgentKind, to: AgentKind): string => {
  const why =
    limit.reason === "failed"
      ? `${AGENT_SHORT[from]}'s last turn failed`
      : limit.until === undefined
        ? `${AGENT_SHORT[from]} is out of usage`
        : `${AGENT_SHORT[from]} is out of usage until ${clockTime(limit.until)}`;
  return `${why}, so ${AGENT_SHORT[to]}'s first turn writes the note from the transcript and does no other work.`;
};

/** What the new agent gets, by whether there is a note and who writes it. */
export const carriesLine = (from: AgentKind, note: boolean, limit: boolean): string =>
  limit
    ? "The last turns (about 24k tokens), the plan, open asks, and the branch and PR."
    : note
      ? `A note from ${AGENT_SHORT[from]}, the plan, open asks, the last turns, and the branch and PR.`
      : "The plan, open asks, the last turns, and the branch and PR.";

/**
 * What the new orchestrator gets: its boot context as always (memory, the charter, the ledger),
 * with the note and the last exchanges with the user.
 */
export const orchestratorCarriesLine = (from: AgentKind, note: boolean, limit: boolean): string =>
  !limit && note
    ? `A note from ${AGENT_SHORT[from]}, your last exchanges, memory, the charter and the ledger.`
    : "Your last exchanges, memory, the charter and the ledger.";

/** The orchestrator's own line: its workers stay as they are, and the pick becomes its model. */
export const ORCHESTRATOR_LINE =
  "Workers keep their own agents, and this pick becomes the workspace's orchestrator model.";

/** What doesn't carry over. */
export const leavesLine = (from: AgentKind): string =>
  `${AGENT_SHORT[from]}'s tool output, reasoning and cache: the first reply is slower.`;

/** A worker's own line: its bindings stay, and the orchestrator hears of it. */
export const WORKER_LINE =
  "Its PR, merge when ready and checks stay with this worker, and its orchestrator is told.";

/**
 * The mode line, only when the mode changes on the way over (§3.5): Claude's Auto becomes Codex's
 * Auto only ungated and on Codex 0.166 or newer; otherwise a worker runs in Bypass
 * (`modeAfterDowngrade`) and a plain thread in Ask. Codex's modes all carry over to Claude.
 */
export const modeLine = (input: {
  readonly mode: PermissionMode;
  readonly to: AgentKind;
  readonly worker: boolean;
  /** The orchestrator drops to Bypass as a worker does (`modeAfterDowngrade`). */
  readonly orchestrator?: boolean;
  /** The workspace's approval gate holds (Supervised, Publish). */
  readonly gated: boolean;
  readonly codexVersion: string | undefined;
}): string | undefined => {
  if (input.to !== "codex" || input.mode !== "auto") return undefined;
  const recent =
    input.codexVersion !== undefined && !isOlderVersion(input.codexVersion, CODEX_AUTO_VERSION);
  if (recent && !input.gated) return undefined;
  const who = input.orchestrator
    ? "the orchestrator"
    : input.worker
      ? "this worker"
      : "this thread";
  const runs = input.worker || input.orchestrator ? "Bypass" : "Ask";
  const why = input.gated
    ? "Its Auto can't keep this workspace's approval gate."
    : "Its Auto needs Codex 0.166 or newer.";
  return `Codex runs ${who} in ${runs}. ${why}`;
};

/** The efforts the sheet offers for `model`: what it lists, up to High. */
export const sheetEfforts = (
  models: readonly AgentModel[] | undefined,
  model: string,
): ReadonlyArray<ReasoningVariant> => {
  const row = models?.find((m) => m.id === model);
  if (row === undefined || !row.supportsEffort) return [];
  return (row.efforts ?? []).filter((effort) => !aboveHigh(effort));
};

/**
 * The model and effort the sheet preselects (§3.5): `picked` when the user picked one in the chip's
 * group; else the target's model for the tier the current model fills, if it has one there; else
 * the target's default. The current effort carries over, clamped to the target's list and never past
 * High; without one, the tier's, else High or the nearest below it.
 */
export const defaultTarget = (input: {
  readonly current: ModelRef;
  readonly to: AgentKind;
  readonly models: readonly AgentModel[];
  /** The current agent's list, to know an alias ("opus") as the model it runs. */
  readonly currentModels?: readonly AgentModel[] | undefined;
  readonly picked?: string | undefined;
}): ModelRef | undefined => {
  const { current, to, models } = input;
  // A family alias ("opus") follows the CLI's newest of that family, which is what the table lists.
  const family = current.agent === "claude" && /^[a-z]+$/.test(current.model) ? current.model : "";
  const runs = (id: string) => {
    if (id === current.model) return true;
    if (family !== "" && id.startsWith(`claude-${family}-`)) return true;
    const row = findListed(current.agent, input.currentModels ?? [], id);
    return row !== undefined && (row.id === current.model || row.resolvedId === current.model);
  };
  const from = current.agent;
  const tier = !isTierAgent(from)
    ? undefined
    : TIERS.find((each) => RECOMMENDED.tiers[each][from].models.some(runs));
  const resolved =
    tier === undefined || !isTierAgent(to)
      ? undefined
      : resolveTier(RECOMMENDED, { tier, agent: to }, { [to]: models });
  const chosen = input.picked === undefined ? undefined : models.find((m) => m.id === input.picked);
  const listed =
    chosen ??
    resolved?.listed ??
    models.find((m) => m.isDefault && m.id !== "default") ??
    models[0];
  if (listed === undefined) return undefined;
  const tierEffort = resolved?.listed.id === listed.id ? resolved.ref.variant : undefined;
  const effort = clampEffort(listed, current.variant ?? tierEffort ?? "high");
  return {
    agent: to,
    model: listed.id,
    ...(effort === undefined ? {} : { variant: effort }),
  };
};

/** The divider's words: "Continued in Codex · GPT-6.1-Sol · 14:02". */
export const switchDividerLabel = (
  handoff: Pick<Handoff, "previousAgent" | "at">,
  modelName: string | undefined,
): string => {
  const to = otherAgent(handoff.previousAgent ?? "claude");
  return [`Continued in ${AGENT_NAMES[to]}`, modelName, clockTime(handoff.at)]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
};

/** The divider's hover: "Before: Claude Code · Opus 5.5 · session 7f3c…". */
export const switchDividerBefore = (
  handoff: Pick<Handoff, "previousAgent" | "previousAgentSessionId">,
  previousModelName: string | undefined,
): string =>
  [
    `Before: ${AGENT_NAMES[handoff.previousAgent ?? "claude"]}`,
    previousModelName,
    handoff.previousAgentSessionId === undefined
      ? undefined
      : `session ${handoff.previousAgentSessionId}`,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");

/** Limit mode's line under the divider, over the new agent's note-writing first turn. */
export const switchLimitMeta = (handoff: Pick<Handoff, "previousAgent" | "noteMode" | "limit">) => {
  if (handoff.noteMode !== "limit") return undefined;
  const from = AGENT_SHORT[handoff.previousAgent ?? "claude"];
  const why =
    handoff.limit === "failed" ? `${from}'s last turn failed` : `${from} was out of usage`;
  return `${why} · this turn writes the note, no work`;
};

// Moving a plain thread or a worker to the other agent ("Continue in Codex…"): whether it's offered,
// why it's greyed, what the sheet preselects, and what its lines say. The server makes the same
// refusals (`agent-switch.ts`) and has the last word; these only keep the UI from offering what it
// would refuse.

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
} from "@gram/contracts";

import { AGENT_LABEL } from "@/agents/agent-label";
import { isOlderVersion } from "@/launch-checks/issues";
import { formatClockTime } from "@/lib/time";

/** What the user calls each agent: "Continue in Claude Code". */
const AGENT_NAMES = AGENT_LABEL;

/** The agent as its own words name it in a sentence: "A note from Claude". */
export const AGENT_SHORT: Readonly<Record<AgentKind, string>> = {
  claude: "Claude",
  codex: "Codex",
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
 * now, why: the server's words. Not offered at all on the orchestrator (its own switch), on Windows,
 * or while the other CLI isn't installed, so Gram with one harness shows nothing new.
 */
export type SwitchOffer =
  | { readonly offered: false }
  | { readonly offered: true; readonly to: AgentKind; readonly refusal?: string };

/** The launch checks found `agent`'s CLI. */
export const installed = (checks: LaunchChecks | undefined, agent: AgentKind): boolean =>
  checks?.tools.find((tool) => tool.tool === agent)?.found === true;

const RUNS_NOW: ReadonlySet<ThreadSummary["status"]> = new Set(["idle", "cold", "error"]);

export const switchOffer = (input: {
  readonly summary: Pick<ThreadSummary, "thread" | "status" | "pendingRequests" | "background">;
  readonly checks: LaunchChecks | undefined;
  readonly platform?: string | undefined;
  /**
   * Whether the other agent lists models to continue on. Its CLI found but listing none, and not
   * signed out, it has nothing to offer.
   */
  readonly listed: boolean;
}): SwitchOffer => {
  const { summary, checks } = input;
  const { thread } = summary;
  if (thread.role === "orchestrator" || input.platform === "win32") return { offered: false };
  const to = otherAgent(thread.model.agent);
  if (!installed(checks, to)) return { offered: false };
  const signedOut = (to === "codex" ? checks?.codexSignIn : checks?.claudeSignIn) === "notSignedIn";
  if (!input.listed && !signedOut) return { offered: false };
  const refusal = refusalOf(summary, to, checks!);
  return refusal === undefined ? { offered: true, to } : { offered: true, to, refusal };
};

const refusalOf = (
  summary: Pick<ThreadSummary, "thread" | "status" | "pendingRequests" | "background">,
  to: AgentKind,
  checks: LaunchChecks,
): string | undefined => {
  const { thread } = summary;
  const from = AGENT_SHORT[thread.model.agent];
  const name = AGENT_NAMES[to];
  if (thread.sessionSwitch !== undefined || !RUNS_NOW.has(summary.status))
    return "Wait for this turn to finish, or stop it, then switch.";
  if (summary.pendingRequests.length > 0)
    return `Answer the open approval first. It can't move to ${name}.`;
  if ((summary.background?.length ?? 0) > 0) return `${from} still has background work running.`;
  if (thread.model.profileId !== undefined)
    return "Switching uses the CLI's own sign-in; it doesn't move gateway accounts.";
  const signIn = to === "codex" ? checks.codexSignIn : checks.claudeSignIn;
  if (signIn === "notSignedIn") return `Sign in to ${name} in Settings → Agents.`;
  if (thread.parked) return "Unarchive this thread before switching it.";
  if (!isLocalHost(effectiveCheckout(thread)))
    return `${name} can't run on this thread's machine yet.`;
  if (
    thread.forkedFrom !== undefined &&
    (thread.agentSessionId === undefined || thread.agentSessionUnused === true)
  )
    return "Send once in this fork first.";
  return undefined;
};

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
  /** The workspace's approval gate holds (Supervised, Publish). */
  readonly gated: boolean;
  readonly codexVersion: string | undefined;
}): string | undefined => {
  if (input.to !== "codex" || input.mode !== "auto") return undefined;
  const recent =
    input.codexVersion !== undefined && !isOlderVersion(input.codexVersion, CODEX_AUTO_VERSION);
  if (recent && !input.gated) return undefined;
  const who = input.worker ? "this worker" : "this thread";
  const runs = input.worker ? "Bypass" : "Ask";
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
  const tier = TIERS.find((each) => RECOMMENDED.tiers[each][current.agent].models.some(runs));
  const resolved =
    tier === undefined
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

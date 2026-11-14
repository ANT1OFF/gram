import type {
  Autonomy,
  HostedMoveCheck,
  HostedMoveDone,
  HostedMoveProgress,
} from "@gram/contracts";

import { formatClockTime } from "@/lib/time";
import { presentAutonomy } from "@/settings/workspace-settings-model";

import type { MoveTarget } from "./move-targets";

export { moveTargets, targetKey, type MoveTarget } from "./move-targets";

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en")} ${n === 1 ? one : many}`;

/** What a move takes with it, as the sheet lists it. */
export const goesLines = (facts: {
  /** The workers the workspace has had, open or closed, where that is known. */
  readonly workers: number;
}): readonly string[] => [
  "Charter, stages and settings",
  "Memory",
  "The orchestrator's conversation",
  facts.workers === 0
    ? "The Board's cards"
    : `The Board's cards and ${count(facts.workers, "worker's", "workers'")} history`,
];

/** What a move leaves on the machine it came from: everything tied to that machine. */
export const STAYS_LINES: readonly string[] = [
  "Agent sessions and terminals",
  "Worktrees and uncommitted changes",
  "Sign-ins and keys",
  "Folder access and approvals in flight",
];

/** What becomes of the workers at work when the move starts, or undefined with none. */
export const runningNote = (
  running: number,
): { readonly title: string; readonly line: string } | undefined =>
  running === 0
    ? undefined
    : {
        title: `${count(running, "worker is", "workers are")} running`,
        line: `${running === 1 ? "It finishes its step, pushes its branch and stops" : "They finish their step, push their branches and stop"}. The server's orchestrator is told where ${running === 1 ? "it" : "each"} got to.`,
      };

const RANK: Readonly<Record<Autonomy, number>> = { supervised: 0, publish: 1, full: 2 };

/**
 * What the sheet says when the organisation there allows less autonomy than the workspace has
 * here; undefined when it keeps its own.
 */
export const autonomyNote = (
  here: Autonomy,
  check: HostedMoveCheck | undefined,
  organisation: string,
): { readonly title: string; readonly line: string } | undefined => {
  const ceiling = check?.ok === true ? check.autonomyCeiling : undefined;
  if (ceiling === undefined || RANK[ceiling] >= RANK[here]) return undefined;
  const to = presentAutonomy(ceiling).label;
  return {
    title: `Autonomy becomes ${to}`,
    line: `It is ${presentAutonomy(here).label} here. ${organisation} allows ${to} at most.`,
  };
};

/** What the sheet says of one repository: that the server reaches it, or that it stays behind. */
export const repositoryLine = (reached: boolean, organisation: string): string =>
  reached
    ? "The server reaches it"
    : `Not in ${organisation}'s GitHub access there. The workspace moves without it.`;

const MB = 1024 * 1024;
const mb = (bytes: number) => Math.max(1, Math.round(bytes / MB));

/** How much of the bundle the server has: "31 MB of 50 MB", or undefined before it is known. */
export const sentText = (progress: HostedMoveProgress | undefined): string | undefined => {
  if (progress?.stage !== "sending") return undefined;
  const { sentBytes, totalBytes } = progress;
  if (sentBytes === undefined || totalBytes === undefined || totalBytes <= 0) return undefined;
  return `${Math.min(mb(sentBytes), mb(totalBytes))} MB of ${mb(totalBytes)} MB`;
};

/** How far the sending is, from 0 to 1, for its bar. */
export const sentShare = (progress: HostedMoveProgress | undefined): number => {
  if (progress === undefined || progress.stage === "stopping") return 0;
  if (progress.stage === "settingUp") return 1;
  const { sentBytes = 0, totalBytes = 0 } = progress;
  return totalBytes <= 0 ? 0 : Math.min(1, Math.max(0, sentBytes / totalBytes));
};

export type StepState = "done" | "now" | "next";

/** The move's three steps, each done, under way or still to come. */
export const moveSteps = (
  progress: HostedMoveProgress | undefined,
  running: number,
): readonly { readonly key: HostedMoveProgress["stage"]; words: string; state: StepState }[] => {
  const order = ["stopping", "sending", "settingUp"] as const;
  const at = order.indexOf(progress?.stage ?? "stopping");
  const state = (index: number): StepState => (index < at ? "done" : index === at ? "now" : "next");
  return [
    {
      key: "stopping",
      words:
        running === 0
          ? "Workspace paused here"
          : at > 0
            ? `Workers stopped, ${count(running, "branch", "branches")} pushed`
            : `Stopping ${count(running, "worker", "workers")}`,
      state: state(0),
    },
    { key: "sending", words: "Sending the workspace", state: state(1) },
    {
      key: "settingUp",
      words: "The server sets it up and its orchestrator reads in",
      state: state(2),
    },
  ];
};

/** What the sheet says once the move is done: where it went, when, and what did not come. */
export const movedLine = (
  done: Extract<HostedMoveDone, { ok: true }>,
  target: Pick<MoveTarget, "host">,
  intl: { readonly timeZone?: string } = {},
): string => {
  const left =
    done.left.length === 0
      ? ""
      : `, and was told what didn't come: ${done.left.join(", ").replace(/, ([^,]*)$/, " and $1")}`;
  return `Moved to ${target.host} at ${formatClockTime(done.movedAt, intl)}. Its orchestrator there has the conversation, memory and Board${left}.`;
};

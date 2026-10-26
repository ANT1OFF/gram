import type {
  AgentRuntime,
  CliUpdateState,
  InstallStep,
  RuntimeInstallState,
  RuntimeSource,
} from "@gram/contracts";

import { CLOCK_TIME } from "@/lib/time";

/** The word beside a version for where it came from; a PATH install is the default and says less. */
export const SOURCE_LABEL: Readonly<Record<RuntimeSource, string>> = {
  path: "your install",
  custom: "custom path",
  managed: "managed",
  bundled: "bundled",
};

/** How a row's version fares, at a glance: nothing for supported, an icon for the rest. */
export type VerdictTone = "ok" | "warning" | "error" | "unknown";

export function verdictTone(runtime: AgentRuntime): VerdictTone {
  if (runtime.resolved === undefined) return "ok";
  switch (runtime.verdict) {
    case "supported":
      return "ok";
    case "graceful":
      return "warning";
    case "unsupported":
      return "error";
    case "unknown":
      return "unknown";
  }
}

/** The newer-release note, as a row says it. */
export interface NewerNote {
  /** `update`: installable and compatible; `waiting`: inside its 24 hours; `pending`: not yet
   * qualified; `blocked`: shown not to work with this Gram. */
  readonly kind: "update" | "waiting" | "pending" | "blocked";
  /** A few words beside the version. */
  readonly summary: string;
  /** One sentence, for the hint. */
  readonly detail: string;
}

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  ...CLOCK_TIME,
});

/** `2 Oct, 17:12`, in the user's time zone. */
export const shortDate = (epochMs: number): string => DATE.format(epochMs);

export function newerNote(runtime: AgentRuntime): NewerNote | undefined {
  const { newer } = runtime;
  if (newer === undefined) return undefined;
  const { version } = newer;
  if (newer.verdict === "unsupported")
    return {
      kind: "blocked",
      summary: `${version} needs a newer Gram`,
      detail: `${version} is out, but doesn't work with this version of Gram. Keep ${runtime.resolved?.version ?? "the current one"} until Gram updates.`,
    };
  if (!newer.eligible)
    return {
      kind: "waiting",
      summary: `${version} after ${shortDate(newer.eligibleAt)}`,
      detail: `${version} came out ${shortDate(newer.publishedAt)}. New releases wait at least 24 hours before Gram suggests them.`,
    };
  if (newer.verdict === "supported")
    return {
      kind: "update",
      summary: `${version} available`,
      detail: `${version} is out and works with this version of Gram.`,
    };
  return {
    kind: "pending",
    summary: `${version} · check pending`,
    detail: `${version} is out, but hasn't been checked with this version of Gram yet. Keep ${runtime.resolved?.version ?? "the current one"} for now.`,
  };
}

/** What the binding is called in the details. */
export function bindingLabel(runtime: AgentRuntime): string {
  const { binding, bindingVersion, cliVersion } = runtime.baseline;
  switch (binding) {
    case "claude-agent-sdk":
      return `Agent SDK ${bindingVersion}, paired with Claude Code ${cliVersion}`;
    case "codex-protocol":
      return `app-server protocol generated from Codex ${cliVersion}`;
  }
}

/** A step's caption: the installer it's for, and whether it pins the version. */
export function stepLabel(step: InstallStep): string {
  const by =
    step.installer === "native"
      ? "Its own installer"
      : step.installer === "unknown"
        ? "Install"
        : step.installer === "brew"
          ? "Homebrew"
          : step.installer;
  return step.exact ? by : `${by}, latest`;
}

const megabytes = (bytes: number) => Math.round(bytes / 1_000_000);

/** The managed store's progress, in a few words; undefined when nothing is under way. */
export function installProgress(state: RuntimeInstallState | undefined): string | undefined {
  if (state === undefined) return undefined;
  switch (state.state) {
    case "downloading":
      return `Downloading ${megabytes(state.receivedBytes)} / ${megabytes(state.totalBytes)} MB`;
    case "verifying":
      return "Verifying";
    case "testing":
      return "Testing";
    case "ready":
      return state.activeSessions > 0
        ? `Update ready · ${state.activeSessions} active session${state.activeSessions === 1 ? "" : "s"}`
        : "Update ready";
    case "failed":
      return `Update failed${state.active === undefined ? "" : `; still using ${state.active.version}`}`;
    case "rolledBack":
      return `Restored ${state.active?.version ?? "the previous version"} after ${state.from} failed to start`;
    case "idle":
      return undefined;
  }
}

/** An install is under way, so Update waits. */
export const installing = (state: RuntimeInstallState | undefined): boolean =>
  state?.state === "downloading" || state?.state === "verifying" || state?.state === "testing";

/** The step a row's Update runs: the one it offers to copy, when Gram can run it. */
const runnableStep = (step: InstallStep | undefined): InstallStep | undefined =>
  step?.run === undefined ? undefined : step;

/**
 * The step Update runs on the user's own CLI, from the Agents row or a launch-check line: the first
 * listed, when Gram can run it and the managed store's Update doesn't stand in.
 */
export const cliUpdateStep = (runtime: AgentRuntime | undefined): InstallStep | undefined =>
  runtime?.managed?.candidate === undefined ? runnableStep(runtime?.installSteps[0]) : undefined;

/** Update's words: the version it brings where the step pins one. */
export const updateLabel = (runtime: AgentRuntime, step: InstallStep): string => {
  const verb = runtime.resolved === undefined ? "Install" : "Update";
  const version = step.version ?? runtime.newer?.version;
  return version === undefined ? verb : `${verb} to ${version}`;
};

/** What running threads keep, for a running or finished update; undefined with none running. */
export function runningThreadsNote(
  name: string,
  state: CliUpdateState | undefined,
): string | undefined {
  if (state?.state !== "running" && state?.state !== "succeeded") return undefined;
  const count = state.runningThreads;
  if (count === 0) return undefined;
  const from = state.state === "succeeded" ? state.from : undefined;
  const to = state.state === "succeeded" ? state.version : undefined;
  const threads = count === 1 ? `1 ${name} thread is` : `${count} ${name} threads are`;
  return `${threads} running: ${count === 1 ? "it keeps" : "they keep"} ${from ?? "the version it started with"} until restarted. New threads use ${to ?? "the new one"}.`;
}

/** A finished update's line, as the row says it. */
export function updateOutcome(
  name: string,
  state: Extract<CliUpdateState, { state: "succeeded" }>,
): { readonly tone: "success" | "warning"; readonly text: string } {
  if (state.version === undefined)
    return { tone: "warning", text: `Finished, but ${name}'s version couldn't be read.` };
  if (state.from !== undefined && state.from === state.version)
    return {
      tone: "warning",
      text: `Finished, but ${name} still reports ${state.version}: another install may come first on PATH.`,
    };
  return { tone: "success", text: `Updated ${name} to ${state.version}.` };
}

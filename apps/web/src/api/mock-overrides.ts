import type { AgentKind } from "@gram/contracts";

/** `"1"`: the session is rejected, as after the server's launch token changed. */
export const MOCK_SESSION_EXPIRED_KEY = "gram.mock.sessionExpired";

const flag = (key: string): string | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

export const mockSessionExpired = (): boolean => flag(MOCK_SESSION_EXPIRED_KEY) === "1";

/**
 * `"board"`: the mock starts with `simulateOrchestration("board")`'s workspace, as a relaunch finds
 * it. `"realistic"`: it starts with `simulateRealistic()`'s working morning instead, the seeded
 * threads' own asks left answered, as the screenshot tour and flows show Gram. `"scale"`: it starts
 * with `seedScale()`'s ten workspaces and 300 threads.
 */
export const MOCK_ORCHESTRATION_KEY = "gram.mock.orchestration";

export const mockStartsWithBoard = (): boolean => flag(MOCK_ORCHESTRATION_KEY) === "board";

export const mockStartsRealistic = (): boolean => flag(MOCK_ORCHESTRATION_KEY) === "realistic";

/** `"scale"`: the mock starts with `seedScale()`'s app at scale, for the performance specs. */
export const mockStartsAtScale = (): boolean => flag(MOCK_ORCHESTRATION_KEY) === "scale";

/** `"1"`: the mock starts with no threads, as a true first run does. */
export const MOCK_FRESH_KEY = "gram.mock.fresh";

export const mockStartsFresh = (): boolean => flag(MOCK_FRESH_KEY) === "1";

/** Comma-separated agents with a registered adapter, e.g. `"claude,codex"`. */
export const MOCK_AGENTS_KEY = "gram.mock.agents";

const AGENT_KINDS = ["claude", "codex"] as const satisfies readonly AgentKind[];

/** The agents `MOCK_AGENTS_KEY` names; only an absent flag uses default fixtures. */
export const mockAgents = (): readonly AgentKind[] | undefined => {
  const value = flag(MOCK_AGENTS_KEY);
  if (value === null) return undefined;
  const named = value.split(",");
  return AGENT_KINDS.filter((agent) => named.includes(agent));
};

/**
 * `"1"`: the mock is a server that runs a browser for its agents, opened in a browser tab: no shell
 * draws a page, and the Preview tab shows what `simulateServerPage` stages.
 */
export const MOCK_SERVER_BROWSER_KEY = "gram.mock.serverBrowser";

export const mockServerBrowser = (): boolean => flag(MOCK_SERVER_BROWSER_KEY) === "1";

/**
 * Comma-separated RPC tags the mock serves as a server older than this build would not: controls
 * backed by them are hidden or greyed, as against such a server.
 */
export const MOCK_SERVER_LACKS_KEY = "gram.mock.serverLacks";

export const mockServerLacks = (): readonly string[] =>
  (flag(MOCK_SERVER_LACKS_KEY) ?? "").split(",").filter((tag) => tag !== "");

/**
 * A message: opening a workspace's orchestrator fails with it, as against a server whose start
 * fails after the workspace is saved, so New workspace's failed Start can be seen.
 */
export const MOCK_FAIL_OPEN_KEY = "gram.mock.failOpen";

export const mockFailOpen = (): string | undefined => flag(MOCK_FAIL_OPEN_KEY) ?? undefined;

/**
 * `"1"`: a fresh session the user starts is under way, then its new session doesn't open, as when
 * the orchestrator's checkout couldn't be put back; the orchestrator ends in error and the
 * workspace pauses, as the server leaves them.
 */
export const MOCK_HANDOFF_FAILS_KEY = "gram.mock.handoffFails";

export const mockHandoffFails = (): boolean => flag(MOCK_HANDOFF_FAILS_KEY) === "1";

/**
 * `"1"`: a memory update the user drafts fails soon after it starts, its agent stopping on an error
 * before it writes anything, as the server records an `agent_error`.
 */
export const MOCK_DREAM_FAILS_KEY = "gram.mock.dreamFails";

export const mockDreamFails = (): boolean => flag(MOCK_DREAM_FAILS_KEY) === "1";

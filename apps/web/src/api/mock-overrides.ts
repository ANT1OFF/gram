import type { AgentKind } from "@gram/contracts";

// e2e specs set these sessionStorage flags to make MockApi behave like an unhappy server.

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

/** `"board"`: the mock starts with `simulateOrchestration("board")`'s workspace, as a relaunch finds it. */
export const MOCK_ORCHESTRATION_KEY = "gram.mock.orchestration";

export const mockStartsWithBoard = (): boolean => flag(MOCK_ORCHESTRATION_KEY) === "board";

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

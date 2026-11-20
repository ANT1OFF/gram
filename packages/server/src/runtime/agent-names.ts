import type { AgentKind } from "@gram/contracts";

/** What the user calls each agent. */
export const AGENT_NAMES: Readonly<Record<AgentKind, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  grok: "Grok Build",
};

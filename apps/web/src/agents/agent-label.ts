import type { AgentKind } from "@gram/contracts";

/**
 * How each agent is named, everywhere one is: pane headers, sidebar rows, pickers, ⌘K, resume,
 * usage, limits and the setup checks. Apart from `AGENT_DISPLAY`'s marks so pure models can name an
 * agent without pulling in React.
 */
export const AGENT_LABEL: Readonly<Record<AgentKind, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
};

/** An agent's name; a kind this build doesn't know shows as itself. */
export const agentLabel = (agent: string): string =>
  Object.hasOwn(AGENT_LABEL, agent) ? AGENT_LABEL[agent as AgentKind] : agent;

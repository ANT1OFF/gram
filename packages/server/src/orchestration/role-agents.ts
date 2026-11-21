import type { AgentKind } from "@gram/contracts";

const OPTIONAL_ROLE_AGENTS: ReadonlyArray<AgentKind> = ["grok", "antigravity"];

/**
 * The agents `GRAM_ROLE_AGENTS` (a comma list) adds to the orchestrator and worker roles. Only
 * Grok Build and Antigravity may be named, and only a deployment whose sessions load no user config
 * of their own should: on a desktop, the CLI reads the user's own allow rules, which could let a
 * push through unasked. Its outward gate is the adapter's: under a gate the session asks about
 * every call.
 */
export const roleAgentsFrom = (value: string | undefined): ReadonlyArray<AgentKind> =>
  OPTIONAL_ROLE_AGENTS.filter((agent) =>
    (value ?? "").split(",").some((entry) => entry.trim().toLowerCase() === agent),
  );

/** The agents this deployment's `GRAM_ROLE_AGENTS` adds to the roles. */
export const ROLE_AGENTS = roleAgentsFrom(process.env["GRAM_ROLE_AGENTS"]);

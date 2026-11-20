// The agents a deployment adds to the orchestrator and worker roles beside Claude Code and Codex.

import type { AgentKind } from "@gram/contracts";

/** The agents a deployment may add to the orchestrator and worker roles (`GRAM_ROLE_AGENTS`). */
const OPTIONAL_ROLE_AGENTS: ReadonlyArray<AgentKind> = ["grok"];

/**
 * The agents `GRAM_ROLE_AGENTS` (a comma list) adds to the orchestrator and worker roles. Only
 * Grok Build may be named, and only a deployment whose sessions load no user config of their own
 * should: on a desktop, Grok reads the user's allow rules, which could let a push through
 * unasked. Its outward gate is the adapter's: under a gate the session asks about every call.
 */
export const roleAgentsFrom = (value: string | undefined): ReadonlyArray<AgentKind> =>
  OPTIONAL_ROLE_AGENTS.filter((agent) =>
    (value ?? "").split(",").some((entry) => entry.trim().toLowerCase() === agent),
  );

/** The agents this deployment's `GRAM_ROLE_AGENTS` adds to the roles. */
export const ROLE_AGENTS = roleAgentsFrom(process.env["GRAM_ROLE_AGENTS"]);

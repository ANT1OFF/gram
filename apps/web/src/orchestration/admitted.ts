import type { AgentKind } from "@gram/contracts";

import { useEmbedShell } from "@/embed/store";

/**
 * The agent kinds that may orchestrate and work. Mirrors the server's `ADMITTED` in
 * `packages/server/src/orchestration/rules.ts`, which is the authority: a pick outside it is
 * refused there. Kept here, and only here, so the pickers don't offer what would be refused.
 */
export const ADMITTED_AGENTS: readonly AgentKind[] = ["claude", "codex"];

/** `ADMITTED_AGENTS` with the agents an embedding app adds where its server admits them. */
export const admittedAgents = (roleAgents: readonly AgentKind[]): readonly AgentKind[] =>
  roleAgents.length === 0 ? ADMITTED_AGENTS : [...ADMITTED_AGENTS, ...roleAgents];

/** The agents the pickers offer for the orchestrator and worker roles here. */
export const useAdmittedAgents = (): readonly AgentKind[] =>
  admittedAgents(useEmbedShell((s) => s.roleAgents));

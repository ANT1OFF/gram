import type { AgentKind } from "@gram/contracts";

/**
 * The agent kinds that may orchestrate, work and dream, which is one list for all three roles.
 * Mirrors the server's `ADMITTED` in `packages/server/src/orchestration/rules.ts`, which is the
 * authority: a pick outside it is refused there. Kept here, and only here, so the pickers don't
 * offer what would be refused.
 */
export const ADMITTED_AGENTS: readonly AgentKind[] = ["claude", "codex"];

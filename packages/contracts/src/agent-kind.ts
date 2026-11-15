// A leaf, so `orchestration.ts` (which `domain.ts` imports) can name an agent too. `domain.ts`
// re-exports it.

import * as Schema from "effect/Schema";

/** The coding agents Gram runs: Claude Code, Codex and OpenCode. */
export const AgentKind = Schema.Literals(["claude", "codex", "opencode"]);
export type AgentKind = typeof AgentKind.Type;

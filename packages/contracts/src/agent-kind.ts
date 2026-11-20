// A leaf, so `orchestration.ts` (which `domain.ts` imports) can name an agent too. `domain.ts`
// re-exports it.

import * as Schema from "effect/Schema";

/** The coding agents Gram runs: Claude Code, Codex, OpenCode and Grok Build. */
export const AgentKind = Schema.Literals(["claude", "codex", "opencode", "grok"]);
export type AgentKind = typeof AgentKind.Type;

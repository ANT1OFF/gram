// A leaf, so `orchestration.ts` (which `domain.ts` imports) can name an agent too. `domain.ts`
// re-exports it.

import * as Schema from "effect/Schema";

/** The coding agents Gram runs: Claude Code, Codex, OpenCode, Grok Build and Antigravity. */
export const AgentKind = Schema.Literals(["claude", "codex", "opencode", "grok", "antigravity"]);
export type AgentKind = typeof AgentKind.Type;

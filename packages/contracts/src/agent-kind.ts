import * as Schema from "effect/Schema";

/** The coding agents Gram runs: Claude Code, Codex, OpenCode, Grok Build and Antigravity. */
export const AgentKind = Schema.Literals(["claude", "codex", "opencode", "grok", "antigravity"]);
export type AgentKind = typeof AgentKind.Type;

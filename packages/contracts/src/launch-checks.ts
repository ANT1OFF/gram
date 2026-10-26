import * as Schema from "effect/Schema";
import { AgentKind } from "./domain.ts";

export const LaunchTool = Schema.Literals(["claude", "git", "gh", "codex"]);
export type LaunchTool = typeof LaunchTool.Type;

/** The agents that run through a gateway profile, whose CLIs Gram pins a tested version of. */
export const GatewayAgentTool = Schema.Literals(["codex"]);
export type GatewayAgentTool = typeof GatewayAgentTool.Type;

/** Another install of a tool further down the PATH, which the shell doesn't pick. */
export const ShadowedInstall = Schema.Struct({
  path: Schema.String,
  version: Schema.optionalKey(Schema.String),
});
export type ShadowedInstall = typeof ShadowedInstall.Type;

/** One command-line tool, looked up on the login-shell PATH. */
export const ToolCheck = Schema.Struct({
  tool: LaunchTool,
  found: Schema.Boolean,
  /** Where it resolved, when found. */
  path: Schema.optionalKey(Schema.String),
  /** `MAJOR.MINOR.PATCH` from `--version`, with any prerelease suffix, when it could be read. */
  version: Schema.optionalKey(Schema.String),
  /**
   * Claude: why no thread can start from the CLI that was found, e.g. a Windows shim with no
   * native `claude.exe` behind it in a packaged app. The same check a session runs before it starts.
   */
  unusable: Schema.optionalKey(Schema.String),
  /** Codex: the version Gram's adapter is tested with. */
  testedVersion: Schema.optionalKey(Schema.String),
  /**
   * With `testedVersion`: the command that installs that version, matching how the binary on PATH
   * was installed (Homebrew or npm), else npm.
   */
  upgradeCommand: Schema.optionalKey(Schema.String),
  /** With `testedVersion`: other installs further down the PATH, when there are several. */
  shadowed: Schema.optionalKey(Schema.Array(ShadowedInstall)),
});
export type ToolCheck = typeof ToolCheck.Type;

/**
 * `claude auth status --json`. Gram needs a subscription login, so an API key or a
 * third-party provider counts as a problem; `unknown` when Claude isn't installed or the status
 * couldn't be read.
 */
export const ClaudeSignIn = Schema.Literals([
  "signedIn",
  "notSignedIn",
  "apiKey",
  "thirdParty",
  "unknown",
]);
export type ClaudeSignIn = typeof ClaudeSignIn.Type;

/** The local CLI's `codex login status`; API-key billing is distinct from a ChatGPT login. */
export const CodexSignIn = Schema.Literals(["signedIn", "notSignedIn", "apiKey", "unknown"]);
export type CodexSignIn = typeof CodexSignIn.Type;

/** What a gateway Codex thread reads from the user's own Codex setup, found by looking at files. */
export const CodexGatewayInherits = Schema.Struct({
  /** The user's skill folders it sees: `~/.agents/skills` and their `CODEX_HOME/skills`. */
  skills: Schema.Array(Schema.String),
  /** Their global `AGENTS.override.md` or `AGENTS.md`, copied into Gram's Codex home. */
  instructions: Schema.optionalKey(Schema.String),
});
export type CodexGatewayInherits = typeof CodexGatewayInherits.Type;

/** `app.launchChecks`: what the app needs from the machine, checked once and again on demand. */
export const LaunchChecks = Schema.Struct({
  /** Epoch milliseconds. */
  checkedAt: Schema.Number,
  tools: Schema.Array(ToolCheck),
  claudeSignIn: ClaudeSignIn,
  /** Optional for older saved/mock responses; absent means unknown, never signed in. */
  codexSignIn: Schema.optionalKey(CodexSignIn),
  /** `gh auth status` succeeded. */
  ghSignedIn: Schema.Boolean,
  /**
   * Version-checked agents this user selected as a default or used in threads. Read fresh
   * on every request; a saved gateway key alone selects no agent.
   */
  agentsInUse: Schema.optionalKey(Schema.Array(GatewayAgentTool)),
  /** Agents selected without a gateway; their own authentication matters to these workflows. */
  localAgentsInUse: Schema.optionalKey(Schema.Array(AgentKind)),
  /** Read fresh on every request, and absent when a gateway Codex thread inherits nothing. */
  codexGatewayInherits: Schema.optionalKey(CodexGatewayInherits),
});
export type LaunchChecks = typeof LaunchChecks.Type;

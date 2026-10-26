/**
 * Which of Claude Code's slash commands a thread offers. The CLI lists every command it knows, its
 * own (`builtin`) beside the user's, but through the Agent SDK many of its own are dead ends: the
 * terminal-bound ones answer "isn't available in this environment", some are internal, and some
 * act on a terminal session Gram never shows. So the user's own commands and every skill
 * are offered, and of the CLI's own only those checked to do something visible in a thread
 * (Claude Code 2.1.286). One that isn't offered still runs when typed.
 */
import type { SlashCommand } from "@gram/contracts";

/** The CLI's own commands that do something visible in a thread. */
const WORKS: ReadonlySet<string> = new Set([
  "autocompact",
  "compact",
  "config",
  "context",
  "init",
  "list-agents",
  "output-style",
  "plugin-types",
  "recap",
  "reload-plugins",
  "reload-skills",
  "security-review",
  "usage",
]);

/**
 * The CLI's own commands that aren't skills and aren't offered: dead ends through the SDK, internal,
 * terminal-bound, ones Gram does itself (`clear`, `model`, `effort`, `mcp`, `rename`), and
 * ones that write the user's account or settings without having been checked here.
 */
const NOT_OFFERED: ReadonlySet<string> = new Set([
  "__remote-workflow",
  "agents",
  "auto-mode-setup",
  "clear",
  "color",
  "design-consent",
  "design-revoke",
  "effort",
  "extra-usage",
  "fast",
  "focus",
  "goal",
  "heapdump",
  "insights",
  "mcp",
  "model",
  "rename",
  "team-onboarding",
  "usage-credits",
  "workflow-launch-exec",
]);

/** A command as `initializationResult()` and `commands_changed` list it. */
export interface ReportedCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly builtin?: boolean;
}

/**
 * Whether the thread offers `command`. `skills` is `system/init`'s list, which names the bundled
 * skills the CLI also marks `builtin`. Before the first turn there is none, so a `builtin` neither
 * list names is taken for a skill until then.
 */
export const offered = (
  command: ReportedCommand,
  skills: ReadonlySet<string> | undefined,
): boolean =>
  command.builtin !== true ||
  WORKS.has(command.name) ||
  (skills === undefined ? !NOT_OFFERED.has(command.name) : skills.has(command.name));

export const toSlashCommand = (c: ReportedCommand): SlashCommand => ({
  name: c.name,
  description: c.description,
  ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
  ...(c.aliases?.length ? { aliases: [...c.aliases] } : {}),
});

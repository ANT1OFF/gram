import type { SlashCommand } from "@gram/contracts";

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

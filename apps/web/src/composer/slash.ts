import type { SlashCommand } from "@gram/contracts";

/** The command name being typed: text after a leading `/` with no whitespace yet. */
export function slashQuery(text: string): string | undefined {
  const match = /^\/(\S*)$/.exec(text);
  return match ? (match[1] ?? "") : undefined;
}

/**
 * Name/alias prefix matches first, then substring matches, then description matches; within each,
 * by `rank` (lower first) and then by name.
 */
export function filterCommands<C extends SlashCommand>(
  commands: readonly C[],
  query: string,
  rank: (command: C) => number = () => 0,
): C[] {
  const q = query.toLowerCase();
  return commands
    .flatMap((command) => {
      const names = [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
      const score = names.some((n) => n.startsWith(q))
        ? 0
        : names.some((n) => n.includes(q))
          ? 1
          : command.description.toLowerCase().includes(q)
            ? 2
            : -1;
      return score === -1 ? [] : [{ command, score }];
    })
    .toSorted(
      (a, b) =>
        a.score - b.score ||
        rank(a.command) - rank(b.command) ||
        a.command.name.localeCompare(b.command.name),
    )
    .map((s) => s.command);
}

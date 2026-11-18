import type {
  ShellRepositoryAbility,
  ShellRepositoryAccess,
  ShellRepositoryAccessPage,
} from "@/embed/contract";

/**
 * How a cell is marked: allowed, a person's to do (merge, where the app keeps it to people), not
 * allowed, or moot where the app leaves a dash because the question doesn't arise.
 */
export const abilityTone = (
  ability: ShellRepositoryAbility,
  person: boolean,
): "yes" | "person" | "no" | "moot" =>
  ability.allowed
    ? "yes"
    : person
      ? "person"
      : /^[—–-]?$/.test(ability.text.trim())
        ? "moot"
        : "no";

/**
 * The page's rows in the order the repositories were asked for, each once: an app may answer in
 * any order, and a repository it said nothing about has no row rather than one that guesses.
 */
export const repositoryAccessRows = (
  asked: readonly string[],
  page: ShellRepositoryAccessPage,
): ShellRepositoryAccess[] => {
  const byName = new Map(page.repositories.map((row) => [row.fullName.toLowerCase(), row]));
  return asked.flatMap((name) => {
    const row = byName.get(name.toLowerCase());
    return row === undefined ? [] : [row];
  });
};

/** The checks a merge waits for, under the repository's name. Unknown is never said as none. */
export const checksLine = (checks: readonly string[] | undefined): string => {
  if (checks === undefined) return "Required checks unknown";
  if (checks.length === 0) return "No checks required to merge";
  const shown = checks.slice(0, 4);
  const more = checks.length - shown.length;
  return `Checks to merge: ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
};

// A workspace's monogram on the compact rail's tile: one letter from its name, two only where
// another workspace's name starts with the same one. No React.

/** A name's words: split at spaces, dashes, underscores, dots, slashes and camelCase humps. */
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/** The letters a name offers, first first: its words' initials, then the rest of its first word. */
const letters = (name: string): string[] => {
  const parts = words(name);
  const initials = parts.map((word) => word[0]!);
  const rest = Array.from((parts[0] ?? "").slice(1));
  return [...initials.slice(0, 1), ...initials.slice(1), ...rest].map((c) => c.toUpperCase());
};

/**
 * Each name's monogram, in order: its first letter ("billing-api" → "B"), or, where two names share
 * that letter, two ("billing-api" → "BA", "backend" → "BC"): the first letter, then the first of
 * its other initials and its first word's letters that no earlier name sharing it took. A name with
 * no letter or digit takes "·".
 */
export const monograms = (names: readonly string[]): readonly string[] => {
  const offered = names.map(letters);
  const first = offered.map((each) => each[0] ?? "·");
  const counts = new Map<string, number>();
  for (const letter of first) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  const taken = new Set<string>();
  return offered.map((each, index) => {
    const one = first[index]!;
    if ((counts.get(one) ?? 0) < 2 || each.length < 2) return one;
    const second = each.slice(1).find((letter) => !taken.has(`${one}${letter}`)) ?? each[1]!;
    const mark = `${one}${second}`;
    taken.add(mark);
    return mark;
  });
};

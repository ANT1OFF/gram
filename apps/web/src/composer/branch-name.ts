export const BRANCH_PREFIXES = ["feat", "fix", "chore", "docs", "refactor", "test"] as const;
export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];

const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "dapper",
  "eager",
  "fuzzy",
  "gentle",
  "hazy",
  "jolly",
  "keen",
  "lucky",
  "mellow",
  "nimble",
  "quiet",
  "rapid",
  "sunny",
  "tidy",
  "vivid",
  "witty",
  "zesty",
];

const ANIMALS = [
  "otter",
  "heron",
  "lynx",
  "badger",
  "falcon",
  "gecko",
  "ibis",
  "koala",
  "lemur",
  "marten",
  "newt",
  "orca",
  "puffin",
  "quokka",
  "raven",
  "seal",
  "tapir",
  "urchin",
  "walrus",
  "yak",
];

/** The default new-branch name: `adjective-animal-hex`. */
export function randomBranchName(random: () => number = Math.random): string {
  const pick = (list: readonly string[]) => list[Math.floor(random() * list.length)]!;
  const hex = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${hex}`;
}

/** `prefix/name`, with whitespace in the name collapsed to dashes. */
export function branchRef(prefix: BranchPrefix | "", name: string): string {
  const clean = name.trim().replaceAll(/\s+/g, "-");
  return prefix ? `${prefix}/${clean}` : clean;
}

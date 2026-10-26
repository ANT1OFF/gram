const ADJECTIVES = [
  "bouncy",
  "brave",
  "breezy",
  "cosmic",
  "cozy",
  "curious",
  "dapper",
  "daring",
  "gentle",
  "happy",
  "jazzy",
  "jolly",
  "lucky",
  "merry",
  "mighty",
  "nimble",
  "peppy",
  "playful",
  "sleepy",
  "snazzy",
  "sparkly",
  "speedy",
  "sunny",
  "zippy",
] as const;

const ANIMALS = [
  "alpaca",
  "badger",
  "beaver",
  "capybara",
  "dolphin",
  "falcon",
  "fox",
  "gecko",
  "heron",
  "koala",
  "lemur",
  "llama",
  "lynx",
  "narwhal",
  "otter",
  "owl",
  "panda",
  "penguin",
  "puffin",
  "quokka",
  "raven",
  "seal",
  "tiger",
  "wombat",
] as const;

/** Conventional Commits types offered by the branch prefix picker. */
export const BRANCH_PREFIXES = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "perf",
  "test",
  "chore",
  "ci",
  "build",
] as const;

/** A default branch name: `adjective-animal-xxxxxx` (6 hex digits). */
export const randomWorktreeName = (random: () => number = Math.random): string => {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(random() * ANIMALS.length)];
  const suffix = Math.floor(random() * 0x100_0000)
    .toString(16)
    .padStart(6, "0");
  return `${adjective}-${animal}-${suffix}`;
};

/**
 * The branch from the optional prefix picker and the typed name. An empty prefix returns the name
 * unchanged; an already-typed prefix isn't doubled (`feat/feat/x`).
 */
export const composeBranch = (prefix: string, typed: string): string => {
  const p = prefix.trim();
  const name = typed.trim();
  if (p === "" || name === "") return name;
  const rest = name.replace(/^\/+/, "");
  // oxlint-disable-next-line gram/no-raw-path -- a branch name's prefix, not a path
  return rest.startsWith(`${p}/`) ? rest : `${p}/${rest}`;
};

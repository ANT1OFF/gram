/** A seeded source of numbers in [0, 1): mulberry32, small and plenty for picking mock outcomes. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed from an env value: a non-negative integer, else `fallback`. */
export function parseSeed(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isInteger(value) && value >= 0
    ? value >>> 0
    : fallback;
}

/** A second seed derived from `seed` and `salt`, so two streams from one seed don't move together. */
export function deriveSeed(seed: number, salt: number): number {
  return Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
}

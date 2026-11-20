// Comparing decoded values as `start.ts` does: a profile's stored settings against those asked for.

/** Two decoded values, alike whatever order their keys were written in. */
export const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((each, index) => sameValue(each, b[index]))
    );
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const left = Object.entries(a).filter(([, v]) => v !== undefined);
    const right = new Map(Object.entries(b).filter(([, v]) => v !== undefined));
    return (
      left.length === right.size &&
      left.every(([key, v]) => right.has(key) && sameValue(v, right.get(key)))
    );
  }
  return a === b;
};

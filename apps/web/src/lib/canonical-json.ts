const jsonless = (value: unknown): boolean =>
  value === undefined || typeof value === "function" || typeof value === "symbol";

/**
 * JSON with every object's keys sorted, so two values serialise alike exactly when they are deeply
 * equal, whatever order their keys were written in. What JSON can't carry (`undefined`, a function)
 * is dropped from an object and `null` in an array, as `JSON.stringify` has it.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => (jsonless(item) ? "null" : canonicalJson(item))).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value)
      .filter(([, field]) => !jsonless(field))
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

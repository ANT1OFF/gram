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
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => !jsonless(record[key]))
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

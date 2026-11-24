import * as Predicate from "effect/Predicate";
/** A JSON object as ACP carries it. */
export type Json = Readonly<Record<string, unknown>>;

/** `value` as an object, or an empty one. */
export const record = (value: unknown): Json => (Predicate.isObject(value) ? value : {});

/** `value` when it is a string. */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** `value` as a list of objects, or an empty one. */
export const records = (value: unknown): ReadonlyArray<Json> =>
  (Array.isArray(value) ? value : []).map(record);

/** A whole, positive count, or zero. */
export const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

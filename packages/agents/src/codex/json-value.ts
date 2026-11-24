import * as Predicate from "effect/Predicate";

import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";

/**
 * `value` as the JSON Codex's config takes, as `JSON.stringify` would write it: `undefined`,
 * functions and symbols leave an object and are `null` in a list, and other objects keep their own
 * enumerable fields.
 */
export const jsonValueOf = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((each: unknown) => jsonValueOf(each));
  if (!Predicate.isObject(value)) return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, each]: [string, unknown]) => kept(each))
      .map(([key, each]: [string, unknown]) => [key, jsonValueOf(each)]),
  );
};

const kept = (value: unknown) =>
  value !== undefined && typeof value !== "function" && typeof value !== "symbol";

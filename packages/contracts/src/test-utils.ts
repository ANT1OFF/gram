import * as Schema from "effect/Schema";
import { expect } from "vitest";

/** Encode, push through JSON like the RPC transport does, decode, and expect the original back. */
export const expectRoundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A): void => {
  const encoded = Schema.encodeSync(schema)(value);
  const wire: unknown = JSON.parse(JSON.stringify(encoded));
  expect(Schema.decodeUnknownSync(schema)(wire)).toEqual(value);
};

export const readFixture = (name: string): Array<Record<string, unknown>> =>
  // oxlint-disable-next-line typescript/consistent-type-imports
  (process.getBuiltinModule("node:fs") as typeof import("node:fs"))
    .readFileSync(new URL(`../../agents/fixtures/claude/${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

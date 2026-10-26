import { describe, expect, it } from "@effect/vitest";
import { AppToolError, type ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { inputAliases, inputLengthProblem } from "./input.ts";
import { bindAppTools, defineAppTool } from "./registry.ts";

describe("tool input aliases", () => {
  it.effect(
    "normalizes aliases before approval and handling, refusing conflicts and unknown keys",
    () =>
      Effect.gen(function* () {
        const approved: unknown[] = [];
        const resolved: unknown[] = [];
        const handled: unknown[] = [];
        const tool = bindAppTools(
          [
            defineAppTool({
              descriptor: {
                name: "example",
                class: "crossThread",
                description: "Use message; text is an alias.",
              },
              rejectExcessProperties: true,
              input: inputAliases(
                Schema.Struct({ text: Schema.NonEmptyString, target: Schema.NonEmptyString }),
                { text: ["message", "content"] },
              ),
              resolve: (_caller, input) =>
                Effect.sync(() => {
                  resolved.push(input);
                  return input;
                }),
              handle: (_caller, input) =>
                Effect.sync(() => {
                  handled.push(input);
                  return { delivered: true };
                }),
            }),
          ],
          "caller" as ThreadId,
          {
            approve: (_caller, _descriptor, input) =>
              Effect.sync(() => {
                approved.push(input);
              }),
          },
        )[0]!;
        for (const field of ["message", "text", "content"]) {
          expect(yield* tool.run({ [field]: "Hello", target: "other" })).toEqual({
            delivered: true,
          });
        }
        for (const input of [
          { message: "Hello", text: "Other", target: "other" },
          { message: "Hello", target: "other", typo: true },
          { target: "other" },
        ]) {
          expect(yield* tool.run(input).pipe(Effect.flip)).toBeInstanceOf(AppToolError);
        }
        expect(resolved).toEqual(
          Array.from({ length: 3 }, () => ({ text: "Hello", target: "other" })),
        );
        expect(approved).toEqual(resolved);
        expect(handled).toEqual(resolved);
      }),
  );

  it("reports lengths through nullable fields and nested schema references without input contents", () => {
    const schema = Schema.Struct({
      hold: Schema.NullOr(Schema.String.check(Schema.isMaxLength(3))),
      rows: Schema.Array(
        Schema.Struct({ text: Schema.String.check(Schema.isMaxLength(2)) }).annotate({
          identifier: "Row",
        }),
      ),
    });
    const document = Schema.toJsonSchemaDocument(schema);
    expect(inputLengthProblem(document, { hold: "abcd", rows: [] })).toBe(
      "hold: limit 3 characters; actual length 4",
    );
    expect(inputLengthProblem(document, { hold: null, rows: [{ text: "abc" }] })).toBe(
      "rows[0].text: limit 2 characters; actual length 3",
    );
    expect(inputLengthProblem(document, { hold: "abc", rows: [{ text: "ab" }] })).toBeUndefined();
  });
});

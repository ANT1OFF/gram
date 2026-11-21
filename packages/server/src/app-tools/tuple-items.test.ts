import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { withTupleItems } from "./tuple-items.ts";

const point = Schema.Tuple([Schema.Number, Schema.Number]);

describe("withTupleItems", () => {
  it("gives a tuple the items Gemini requires, keeping its exact shape", () => {
    const doc = Schema.toJsonSchemaDocument(Schema.Struct({ at: Schema.optionalKey(point) }));
    const at = (withTupleItems(doc.schema) as { properties: { at: Record<string, unknown> } })
      .properties.at;
    expect(at["items"]).toEqual((at["prefixItems"] as unknown[])[0]);
    expect(at).toMatchObject({ minItems: 2, maxItems: 2 });
  });

  it("allows any of a mixed tuple's kinds, and reaches nested tuples", () => {
    const doc = Schema.toJsonSchemaDocument(
      Schema.Struct({
        drag: Schema.Struct({ from: Schema.Tuple([Schema.String, Schema.Number]) }),
      }),
    );
    const from = (
      withTupleItems(doc.schema) as {
        properties: { drag: { properties: { from: Record<string, unknown> } } };
      }
    ).properties.drag.properties.from;
    expect(from["items"]).toEqual({ anyOf: from["prefixItems"] });
  });
});

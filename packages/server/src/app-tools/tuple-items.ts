type Json = unknown;

const isRecord = (value: Json): value is Record<string, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON Schema with an `items` beside every tuple's `prefixItems`: some model APIs (Gemini's)
 * refuse an array without `items`. `prefixItems` and the length bounds still say the exact shape.
 */
export const withTupleItems = (schema: Json): Json => {
  if (Array.isArray(schema)) return schema.map(withTupleItems);
  if (!isRecord(schema)) return schema;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) out[key] = withTupleItems(value);
  const prefix = out["prefixItems"];
  if (Array.isArray(prefix) && prefix.length > 0 && out["items"] === undefined) {
    const kinds = [...new Map(prefix.map((each) => [JSON.stringify(each), each])).values()];
    out["items"] = kinds.length === 1 ? kinds[0] : { anyOf: kinds };
  }
  return out;
};

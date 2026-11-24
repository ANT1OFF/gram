import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Predicate from "effect/Predicate";

type PureFields = { readonly [x: PropertyKey]: Schema.ConstraintCodec<unknown, unknown> };

/**
 * Publish and decode equivalent spellings before resolution and approval. Different values for
 * the same field are refused: an alias must never silently change the target or the approved text.
 * Handlers and existing result shapes keep the original field names.
 */
export const inputAliases = <F extends PureFields>(
  schema: Schema.Struct<F>,
  aliases: Readonly<Record<string, ReadonlyArray<string>>>,
) => {
  const fields: { -readonly [K in keyof PureFields]: PureFields[K] } = { ...schema.fields };
  for (const [field, alternatives] of Object.entries(aliases)) {
    const value = schema.fields[field];
    if (value === undefined) throw new Error(`Unknown input alias field: ${field}`);
    fields[field] = Schema.optionalKey(value);
    for (const alias of alternatives) fields[alias] = Schema.optionalKey(value);
  }
  return Schema.Struct(fields)
    .check(
      Schema.makeFilter((input) => {
        for (const [field, alternatives] of Object.entries(aliases)) {
          const supplied = [field, ...alternatives].filter((key) => input[key] !== undefined);
          if (supplied.some((key) => input[key] !== input[supplied[0]!])) {
            return `${field}: conflicting aliases (${supplied.join(", ")}); supply one value`;
          }
        }
        return true;
      }),
    )
    .pipe(
      Schema.decodeTo(schema, {
        decode: SchemaGetter.transform((input) => {
          const normalized = { ...input };
          for (const [field, alternatives] of Object.entries(aliases)) {
            for (const alias of alternatives) {
              if (normalized[alias] !== undefined) normalized[field] = normalized[alias];
              delete normalized[alias];
            }
          }
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- with every alias folded back into its field, what is left is the schema's own encoded shape
          return normalized as Schema.Struct<F>["Encoded"];
        }),
        encode: SchemaGetter.transform((input) => input),
      }),
    );
};

/** Field paths, limits and actual lengths without echoing possibly sensitive or enormous input. */
export const inputLengthProblem = (
  document: ReturnType<typeof Schema.toJsonSchemaDocument>,
  input: unknown,
): string | undefined => {
  const visit = (schema: unknown, value: unknown, path: string): string | undefined => {
    if (!Predicate.isObject(schema)) return undefined;
    const node = schema;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
      return visit(document.definitions[node.$ref.slice(8)], value, path);
    }
    if (Array.isArray(node.anyOf)) {
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const branches = node.anyOf.filter((branch: unknown) => {
        if (!Predicate.isObject(branch)) return false;
        const declared = branch.type;
        return (
          declared === undefined ||
          declared === type ||
          (Array.isArray(declared) && declared.includes(type))
        );
      });
      const problems = branches.map((branch: unknown) => visit(branch, value, path));
      if (
        problems.length > 0 &&
        problems.every((problem: string | undefined) => problem !== undefined)
      )
        return problems[0];
    }
    const sized =
      typeof value === "string"
        ? { limit: node.maxLength, length: value.length, unit: "characters" }
        : Array.isArray(value)
          ? { limit: node.maxItems, length: value.length, unit: "items" }
          : undefined;
    if (typeof sized?.limit === "number" && sized.length > sized.limit) {
      return `${path}: limit ${sized.limit} ${sized.unit}; actual length ${sized.length}`;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const problem = visit(node.items, value[i], `${path}[${i}]`);
        if (problem !== undefined) return problem;
      }
    } else if (Predicate.isObject(value)) {
      const properties = Predicate.isObject(node.properties) ? node.properties : {};
      for (const [key, child] of Object.entries(properties)) {
        const problem = visit(child, value[key], path ? `${path}.${key}` : key);
        if (problem !== undefined) return problem;
      }
    }
    for (const child of Array.isArray(node.allOf) ? node.allOf : []) {
      const problem = visit(child, value, path);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return visit(document.schema, input, "");
};

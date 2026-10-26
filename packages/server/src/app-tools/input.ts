import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/**
 * Publish and decode equivalent spellings before resolution and approval. Different values for
 * the same field are refused: an alias must never silently change the target or the approved text.
 * Handlers and existing result shapes keep the original field names.
 */
export const inputAliases = <F extends Schema.Struct.Fields>(
  schema: Schema.Struct<F>,
  aliases: Readonly<Record<string, ReadonlyArray<string>>>,
) => {
  const fields: { -readonly [K in keyof Schema.Struct.Fields]: Schema.Struct.Fields[K] } = {
    ...schema.fields,
  };
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
    if (schema === null || typeof schema !== "object") return undefined;
    const node = schema as Record<string, unknown>;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
      return visit(document.definitions[node.$ref.slice(8)], value, path);
    }
    // Nullable fields and other unions keep their constraints inside anyOf. Only matching
    // JSON types participate, and one branch permitting the length is enough for an anyOf.
    if (Array.isArray(node.anyOf)) {
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      const branches = node.anyOf.filter((branch: unknown) => {
        if (branch === null || typeof branch !== "object") return false;
        const declared = (branch as Record<string, unknown>).type;
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
    const limit =
      typeof value === "string" ? node.maxLength : Array.isArray(value) ? node.maxItems : undefined;
    if (typeof limit === "number" && (value as string | unknown[]).length > limit) {
      return `${path}: limit ${limit} ${typeof value === "string" ? "characters" : "items"}; actual length ${(value as string | unknown[]).length}`;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const problem = visit(node.items, value[i], `${path}[${i}]`);
        if (problem !== undefined) return problem;
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(
        (node.properties ?? {}) as Record<string, unknown>,
      )) {
        const problem = visit(
          child,
          (value as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key,
        );
        if (problem !== undefined) return problem;
      }
    }
    for (const child of (node.allOf ?? []) as unknown[]) {
      const problem = visit(child, value, path);
      if (problem !== undefined) return problem;
    }
    return undefined;
  };
  return visit(document.schema, input, "");
};

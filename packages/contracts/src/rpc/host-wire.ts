import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcSchema from "effect/rpc/RpcSchema";

/**
 * The host protocol as it crosses the wire, written down as data so one build's protocol can be
 * compared with another's. Each release's copy is checked in beside this file
 * (`host-released/<release>.json`), and `hostWireBreaks` says what a later build changed that a host or control plane of that
 * release can't live with. See docs/MACHINES.md, "Machines on different releases".
 */

/** A JSON Schema node, as `Schema.toJsonSchemaDocument` writes one. */
export type WireSchema = { readonly [key: string]: unknown };

/** One side of a call: what is sent, with the named schemas it refers to. */
export interface WirePart {
  readonly schema: WireSchema;
  readonly definitions: { readonly [name: string]: WireSchema };
}

/** One call: what the control plane sends, and what the host answers or fails with. */
export interface WireCall {
  /** Whether the answer is a stream of `success` values. */
  readonly stream: boolean;
  readonly payload: WirePart;
  readonly success: WirePart;
  readonly error: WirePart;
}

/** A build's host protocol. */
export interface HostWire {
  /** The protocol version the build speaks. */
  readonly protocol: number;
  /** The capabilities a host must name in its hello for the build's control plane to use it. */
  readonly requires: ReadonlyArray<string>;
  readonly calls: { readonly [tag: string]: WireCall };
}

const part = (schema: Schema.Top): WirePart => {
  const document = Schema.toJsonSchemaDocument(Schema.toCodecJson(schema));
  return {
    schema: document.schema as WireSchema,
    definitions: document.definitions as WirePart["definitions"],
  };
};

/** Writes down `rpcs` as the JSON each call puts on the wire. */
export const describeHostWire = (
  rpcs: { readonly requests: ReadonlyMap<string, unknown> },
  about: { readonly protocol: number; readonly requires: ReadonlyArray<string> },
): HostWire => {
  const calls: Record<string, WireCall> = {};
  const tags = [...rpcs.requests.keys()].toSorted();
  for (const tag of tags) {
    const rpc = rpcs.requests.get(tag) as unknown as Rpc.AnyWithProps;
    const success = rpc.successSchema;
    calls[tag] = RpcSchema.isStreamSchema(success)
      ? {
          stream: true,
          payload: part(rpc.payloadSchema),
          success: part(success.success),
          error: part(Schema.Union([success.error, rpc.errorSchema])),
        }
      : {
          stream: false,
          payload: part(rpc.payloadSchema),
          success: part(success),
          error: part(rpc.errorSchema),
        };
  }
  return { protocol: about.protocol, requires: [...about.requires].toSorted(), calls };
};

/** What a later build did to something a released peer relies on. */
export interface WireBreak {
  /** Where: the call, the side of it and the path into that side, such as `host.hello success.capabilities[]`. */
  readonly at: string;
  readonly what: string;
}

/** Keys that describe a value without changing which values are read. */
const NOTES = new Set(["title", "description", "default", "examples", "$comment", "deprecated"]);
/** Keys this walks into, rather than comparing whole. */
const WALKED = new Set([
  "$ref",
  "anyOf",
  "enum",
  "const",
  "properties",
  "required",
  "items",
  "prefixItems",
  "additionalProperties",
]);

const text = (value: unknown) => JSON.stringify(value);

interface Side {
  readonly node: WireSchema;
  readonly definitions: WirePart["definitions"];
}

/** Follows `$ref` to the schema it names; the name is kept to stop at a schema that holds itself. */
const resolve = (side: Side): { readonly side: Side; readonly names: ReadonlyArray<string> } => {
  const names: Array<string> = [];
  let node = side.node;
  while (typeof node["$ref"] === "string") {
    const name = node["$ref"].replace(/^#\/\$defs\//, "");
    const next = side.definitions[name];
    if (next === undefined || names.includes(name)) break;
    names.push(name);
    node = next;
  }
  return { side: { node, definitions: side.definitions }, names };
};

const values = (node: WireSchema): ReadonlyArray<unknown> | undefined =>
  Array.isArray(node["enum"]) ? node["enum"] : "const" in node ? [node["const"]] : undefined;

const isObject = (value: unknown): value is WireSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compare = (
  released: Side,
  current: Side,
  at: string,
  seen: ReadonlySet<string>,
): ReadonlyArray<WireBreak> => {
  const was = resolve(released);
  const now = resolve(current);
  // A schema that holds itself is compared once.
  const pair = `${was.names.join(">")}|${now.names.join(">")}`;
  if (was.names.length > 0 && now.names.length > 0) {
    if (seen.has(pair)) return [];
    seen = new Set([...seen, pair]);
  }
  const a = was.side.node;
  const b = now.side.node;
  const found: Array<WireBreak> = [];
  const say = (what: string, where = at) => found.push({ at: where, what });
  const under = (node: WireSchema, definitions: WirePart["definitions"]): Side => ({
    node,
    definitions,
  });

  // A choice between shapes: every released shape must still be there, and none may be new, since
  // a released peer can't read a shape it never knew. A value that can't be (`never`, as a call
  // with no error has it) is a choice of no shapes.
  const aChoice = shapes(a);
  const bChoice = shapes(b);
  if (aChoice !== undefined || bChoice !== undefined) {
    const olds = aChoice ?? [a];
    const news = bChoice ?? [b];
    const taken = new Set<number>();
    const pending: Array<WireSchema> = [];
    const between = (old: WireSchema, fresh: WireSchema) =>
      compare(
        under(old, released.definitions),
        under(fresh, current.definitions),
        olds.length > 1 ? `${at}(${label(old, released)})` : at,
        seen,
      );
    // First each shape that is there unchanged, then the ones told apart by the same values.
    for (const old of olds) {
      const same = news.findIndex(
        (fresh, index) => !taken.has(index) && between(old, fresh).length === 0,
      );
      if (same === -1) pending.push(old);
      else taken.add(same);
    }
    for (const old of pending) {
      const tag = tagOf(old, released);
      let best: { readonly index: number; readonly breaks: ReadonlyArray<WireBreak> } | undefined;
      for (const [index, fresh] of news.entries()) {
        if (taken.has(index) || tagOf(fresh, current) !== tag) continue;
        const breaks = between(old, fresh);
        if (best === undefined || breaks.length < best.breaks.length) best = { index, breaks };
      }
      if (best === undefined) say(`one of its shapes was removed: ${label(old, released)}`);
      else {
        taken.add(best.index);
        found.push(...best.breaks);
      }
    }
    for (const [index, fresh] of news.entries())
      if (!taken.has(index)) say(`it gained a shape: ${label(fresh, current)}`);
    return found;
  }

  const aValues = values(a);
  const bValues = values(b);
  if (aValues !== undefined || bValues !== undefined) {
    if (aValues === undefined) say("it now takes only named values");
    else if (bValues === undefined) say("it no longer names its values");
    else {
      const gone = aValues.filter((value) => !bValues.some((other) => text(other) === text(value)));
      const added = bValues.filter(
        (value) => !aValues.some((other) => text(other) === text(value)),
      );
      if (gone.length > 0) say(`it no longer takes ${gone.map(text).join(", ")}`);
      if (added.length > 0) say(`it now also takes ${added.map(text).join(", ")}`);
    }
  }

  const aFields = isObject(a["properties"]) ? (a["properties"] as Record<string, WireSchema>) : {};
  const bFields = isObject(b["properties"]) ? (b["properties"] as Record<string, WireSchema>) : {};
  const aRequired = new Set(Array.isArray(a["required"]) ? (a["required"] as string[]) : []);
  const bRequired = new Set(Array.isArray(b["required"]) ? (b["required"] as string[]) : []);
  for (const [name, old] of Object.entries(aFields)) {
    const fresh = bFields[name];
    const where = `${at}.${name}`;
    if (fresh === undefined) {
      say("the field was removed", where);
      continue;
    }
    if (aRequired.has(name) && !bRequired.has(name))
      say("the field was always sent and may now be left out", where);
    if (!aRequired.has(name) && bRequired.has(name))
      say("the field could be left out and is now required", where);
    found.push(
      ...compare(under(old, released.definitions), under(fresh, current.definitions), where, seen),
    );
  }
  for (const name of Object.keys(bFields))
    if (!(name in aFields) && bRequired.has(name)) say("a new field is required", `${at}.${name}`);

  const each = (key: "items" | "additionalProperties", suffix: string) => {
    const old = a[key];
    const fresh = b[key];
    if (isObject(old) && isObject(fresh))
      found.push(
        ...compare(
          under(old, released.definitions),
          under(fresh, current.definitions),
          `${at}${suffix}`,
          seen,
        ),
      );
    else if (text(old) !== text(fresh))
      say(`its ${key} changed from ${text(old)} to ${text(fresh)}`);
  };
  each("items", "[]");
  each("additionalProperties", "{}");

  const aTuple = Array.isArray(a["prefixItems"]) ? (a["prefixItems"] as WireSchema[]) : [];
  const bTuple = Array.isArray(b["prefixItems"]) ? (b["prefixItems"] as WireSchema[]) : [];
  if (aTuple.length !== bTuple.length)
    say(`its tuple went from ${aTuple.length} to ${bTuple.length} places`);
  for (const [index, old] of aTuple.entries()) {
    const fresh = bTuple[index];
    if (fresh !== undefined)
      found.push(
        ...compare(
          under(old, released.definitions),
          under(fresh, current.definitions),
          `${at}[${index}]`,
          seen,
        ),
      );
  }

  // Everything else (its type, bounds, patterns) reads the same values only when it is the same.
  if (text(a["type"]) !== text(b["type"])) {
    say(`its type changed from ${text(a["type"]) ?? "any"} to ${text(b["type"]) ?? "any"}`);
    return found;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (NOTES.has(key) || WALKED.has(key)) continue;
    if (text(a[key]) !== text(b[key]))
      say(`its ${key} changed from ${text(a[key]) ?? "nothing"} to ${text(b[key]) ?? "nothing"}`);
  }
  return found;
};

/** The shapes a value chooses between; none for a value that can't be. */
const shapes = (node: WireSchema): ReadonlyArray<WireSchema> | undefined => {
  const never = (candidate: WireSchema) => text(candidate["not"]) === "{}";
  if (never(node)) return [];
  return Array.isArray(node["anyOf"])
    ? (node["anyOf"] as ReadonlyArray<WireSchema>).filter((member) => !never(member))
    : undefined;
};

/** The fields of a shape that take one value each, which tell it apart from its siblings. */
const tagOf = (node: WireSchema, side: Side): string => {
  const resolved = resolve({ node, definitions: side.definitions }).side.node;
  const fields = isObject(resolved["properties"])
    ? (resolved["properties"] as Record<string, WireSchema>)
    : {};
  return Object.entries(fields)
    .flatMap(([name, field]) => {
      const named = values(field);
      return named !== undefined && named.length === 1 ? [`${name} ${text(named[0])}`] : [];
    })
    .join(", ");
};

/** A shape of a choice, named by the values that tell it apart, for a message. */
const label = (node: WireSchema, side: Side): string => {
  const tag = tagOf(node, side);
  if (tag !== "") return tag;
  const resolved = resolve({ node, definitions: side.definitions }).side.node;
  const named = values(resolved);
  if (named !== undefined) return named.map(text).join(", ");
  if (typeof resolved["type"] === "string") return resolved["type"];
  const brief = text(resolved);
  return brief.length > 80 ? `${brief.slice(0, 77)}...` : brief;
};

/**
 * What `current` changed that a host or control plane built from `released` relies on. Either side
 * may be the older one, so each message is both read and written by a released build:
 *
 * - a call, or a field of one, may not be removed;
 * - a field may not become required, nor a required one optional, and a new field may not be
 *   required;
 * - a value may not change its type, its bounds or the values it names, and a choice between
 *   shapes may not gain or lose one.
 *
 * What may be added freely is a call and an optional field: a released build answers a call it
 * doesn't know with an unknown-request defect, and ignores a field it doesn't name.
 */
export const hostWireBreaks = (released: HostWire, current: HostWire): ReadonlyArray<WireBreak> => {
  const found: Array<WireBreak> = [];
  if (released.protocol !== current.protocol)
    found.push({
      at: "protocol",
      what: `the version went from ${released.protocol} to ${current.protocol}`,
    });
  for (const need of current.requires)
    if (!released.requires.includes(need))
      found.push({ at: "requires", what: `a host must now serve "${need}"` });
  for (const [tag, was] of Object.entries(released.calls)) {
    const now = current.calls[tag];
    if (now === undefined) {
      found.push({ at: tag, what: "the call was removed" });
      continue;
    }
    if (was.stream !== now.stream)
      found.push({
        at: tag,
        what: was.stream ? "it no longer answers with a stream" : "it now answers with a stream",
      });
    for (const side of ["payload", "success", "error"] as const)
      found.push(
        ...compare(
          { node: was[side].schema, definitions: was[side].definitions },
          { node: now[side].schema, definitions: now[side].definitions },
          `${tag} ${side}`,
          new Set(),
        ),
      );
  }
  return found;
};

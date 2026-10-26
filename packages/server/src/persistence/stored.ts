// The server's one way of reading back JSON it stored itself. Decoding here never throws: a value
// that doesn't decode comes back `unreadable` with the field paths that failed, and the caller
// decides by the kind of data what that means. Nothing here writes, so a value that doesn't decode
// stays on disk exactly as it was, and what is logged about it is where it failed, never what it
// holds.

import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaParser from "effect/SchemaParser";

/** Where in a stored value something failed: object keys and array indexes, root first. */
export type FieldPath = ReadonlyArray<PropertyKey>;

export type Decoded<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly paths: ReadonlyArray<FieldPath> };

type Json = unknown;

const codec = <S extends Schema.Top>(schema: S) =>
  schema as unknown as Schema.Codec<S["Type"], unknown>;

interface IssueAt {
  readonly path: FieldPath;
  readonly unexpected: boolean;
}

const issuesOf = (issue: SchemaIssue.Issue, path: FieldPath, out: Array<IssueAt>): void => {
  switch (issue._tag) {
    case "Pointer":
      return issuesOf(issue.issue, [...path, ...issue.path], out);
    case "Composite":
      for (const inner of issue.issues) issuesOf(inner, path, out);
      return;
    case "Encoding":
    case "Filter":
      return issuesOf(issue.issue, path, out);
    default:
      // A union's members each fail somewhere else; the union itself is what failed here.
      out.push({ path, unexpected: issue._tag === "UnexpectedKey" });
  }
};

const decodeValue = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  options?: SchemaAST.ParseOptions,
): Result.Result<S["Type"], ReadonlyArray<IssueAt>> =>
  Result.mapError(SchemaParser.decodeUnknownResult(codec(schema))(input, options), (issue) => {
    const out: Array<IssueAt> = [];
    issuesOf(issue, [], out);
    return out;
  });

const encodeValue = <S extends Schema.Top>(schema: S, value: S["Type"]): Json =>
  Result.getOrUndefined(SchemaParser.encodeUnknownResult(codec(schema))(value));

const parse = (text: string): Result.Result<Json, undefined> => {
  try {
    return Result.succeed(JSON.parse(text) as Json);
  } catch {
    // Not JSON at all: unreadable as a whole, which the empty path says.
    return Result.fail(undefined);
  }
};

/**
 * `text`, a JSON value the server stored, decoded with `schema` as it stands in this build. Keys the
 * schema doesn't know are dropped unless `options` say otherwise.
 */
export const decodeStored = <S extends Schema.Top>(
  schema: S,
  text: string,
  options?: SchemaAST.ParseOptions,
): Decoded<S["Type"]> => {
  const json = parse(text);
  return Result.isFailure(json)
    ? { ok: false, paths: [[]] }
    : decodeStoredValue(schema, json.success, options);
};

/** `decodeStored` of a value already parsed, such as one element of a stored list. */
export const decodeStoredValue = <S extends Schema.Top>(
  schema: S,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): Decoded<S["Type"]> => {
  const decoded = decodeValue(schema, value, options);
  return Result.isSuccess(decoded)
    ? { ok: true, value: decoded.success }
    : { ok: false, paths: decoded.failure.map((issue) => issue.path) };
};

export const mapDecoded = <A, B>(decoded: Decoded<A>, f: (value: A) => B): Decoded<B> =>
  decoded.ok ? { ok: true, value: f(decoded.value) } : decoded;

/** An object key that reads as a field name; any other (a record's key) is user data and masked. */
const FIELD_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/** A path as logged: `agents.claude.model`, with array indexes kept and data-shaped keys as `*`. */
export const describePath = (path: FieldPath): string =>
  path.length === 0
    ? "(root)"
    : path
        .map((key) =>
          typeof key === "number"
            ? String(key)
            : typeof key === "string" && FIELD_NAME.test(key)
              ? key
              : "*",
        )
        .join(".");

/** How many failed paths one log line names; the rest are counted. */
const FIELDS_LOGGED = 8;

/**
 * A logger for stored values that don't decode, telling of each once per run (a sidebar refresh
 * reads every thread again): the table, the row's key and the field paths that failed.
 */
export const makeUnreadableLog = () => {
  const told = new Set<string>();
  return (table: string, key: string, paths: ReadonlyArray<FieldPath>): Effect.Effect<void> =>
    Effect.suspend(() => {
      const fields = [...new Set(paths.map(describePath))];
      const id = `${table}\0${key}\0${fields.join("\0")}`;
      if (told.has(id)) return Effect.void;
      told.add(id);
      return Effect.logWarning("stored row unreadable").pipe(
        Effect.annotateLogs({
          table,
          key,
          fields: fields.slice(0, FIELDS_LOGGED),
          ...(fields.length > FIELDS_LOGGED ? { moreFields: fields.length - FIELDS_LOGGED } : {}),
        }),
      );
    });
};

export type UnreadableLog = ReturnType<typeof makeUnreadableLog>;

/**
 * The rows that decode, in order, after telling `log` of each that doesn't. A list read takes this,
 * so one bad row leaves the list one shorter instead of failing it.
 */
export const readableRows = <Row, A>(
  log: UnreadableLog,
  table: string,
  rows: ReadonlyArray<Row>,
  keyOf: (row: Row) => string,
  decode: (row: Row) => Decoded<A>,
): Effect.Effect<Array<A>> => {
  const values: Array<A> = [];
  const bad: Array<readonly [string, ReadonlyArray<FieldPath>]> = [];
  for (const row of rows) {
    const decoded = decode(row);
    if (decoded.ok) values.push(decoded.value);
    else bad.push([keyOf(row), decoded.paths]);
  }
  return bad.length === 0
    ? Effect.succeed(values)
    : Effect.as(
        Effect.forEach(bad, ([key, paths]) => log(table, key, paths), { discard: true }),
        values,
      );
};

/** One row's value, or `undefined` once `log` has been told it doesn't decode. */
export const readableRow = <A>(
  log: UnreadableLog,
  table: string,
  key: string,
  decoded: Decoded<A>,
): Effect.Effect<A | undefined> =>
  decoded.ok ? Effect.succeed(decoded.value) : Effect.as(log(table, key, decoded.paths), undefined);

const isObject = (value: unknown): value is Record<PropertyKey, Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getAt = (value: Json, path: FieldPath): Json => {
  let node = value;
  for (const key of path) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
};

/** Sets `path` in `root`, a plain object, or deletes it for `undefined`; parents must exist. */
const setAt = (root: Record<PropertyKey, Json>, path: FieldPath, value: Json): void => {
  const parent = getAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (!isObject(parent) || key === undefined) return;
  if (value === undefined) delete parent[key];
  else parent[key] = structuredClone(value);
};

/** `setAt`, making the plain objects missing on the way. */
const setDeep = (root: Record<PropertyKey, Json>, path: FieldPath, value: Json): void => {
  let node: Record<PropertyKey, Json> = root;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!isObject(next)) {
      if (value === undefined) return;
      node[key] = {};
    }
    node = node[key] as Record<PropertyKey, Json>;
  }
  setAt(node, path.slice(-1), value);
};

const sameJson = (a: Json, b: Json): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => sameJson(a[key], b[key]))
  );
};

const samePath = (a: FieldPath, b: FieldPath) =>
  a.length === b.length && a.every((key, index) => key === b[index]);

/**
 * Where a failure at `path` is mended from the defaults: as deep as both the stored value and the
 * defaults are objects, so a bad leaf costs only that leaf, but never inside an array or a record
 * the defaults don't have, whose entries the defaults can't stand in for one by one.
 */
const mendPoint = (stored: Json, defaults: Json, path: FieldPath): FieldPath => {
  let s = stored;
  let d = defaults;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const nextS = isObject(s) ? s[key] : undefined;
    const nextD = isObject(d) ? d[key] : undefined;
    if (!isObject(nextS) || !isObject(nextD)) return path.slice(0, i + 1);
    s = nextS;
    d = nextD;
  }
  return path;
};

/** `paths` without those inside another of them. */
const outermost = (paths: ReadonlyArray<FieldPath>): ReadonlyArray<FieldPath> =>
  paths.filter(
    (path) =>
      !paths.some(
        (other) => other.length < path.length && other.every((key, index) => key === path[index]),
      ),
  );

/** Mending rounds before giving up and taking the defaults whole. */
const MEND_ROUNDS = 32;

export interface Mended<A> {
  readonly value: A;
  /** The paths the defaults stand in at; `[[]]` when nothing of the stored value could be kept. */
  readonly mended: ReadonlyArray<FieldPath>;
}

/**
 * A stored singleton decoded field by field: each part that doesn't decode takes the defaults'
 * value instead (or is left out where the defaults have none), and the rest is kept.
 */
export const decodeMended = <S extends Schema.Top>(
  schema: S,
  defaults: S["Type"],
  encodedDefaults: Json,
  text: string,
): Mended<S["Type"]> => {
  const whole: Mended<S["Type"]> = { value: defaults, mended: [[]] };
  const json = parse(text);
  if (Result.isFailure(json) || !isObject(json.success)) return whole;
  const first = decodeValue(schema, json.success);
  if (Result.isSuccess(first)) return { value: first.success, mended: [] };
  const working = structuredClone(json.success);
  const mended: Array<FieldPath> = [];
  for (let round = 0; round < MEND_ROUNDS; round++) {
    const decoded = decodeValue(schema, working, { errors: "all" });
    if (Result.isSuccess(decoded)) return { value: decoded.success, mended: outermost(mended) };
    const earlier = mended.slice();
    for (const { path } of decoded.failure) {
      let at = mendPoint(working, encodedDefaults, path);
      // Mended there in an earlier round and failing again: the defaults' part doesn't fit what
      // was kept around it, so mend one level up.
      while (at.length > 0 && earlier.some((done) => samePath(done, at))) at = at.slice(0, -1);
      if (at.length === 0) return whole;
      if (mended.some((done) => samePath(done, at))) continue;
      setAt(working, at, getAt(encodedDefaults, at));
      mended.push(at);
    }
  }
  return whole;
};

/**
 * The paths of keys in `json` that `schema` doesn't know: what a newer build stored, which a write
 * by this one should carry along. One inside a list is given as the list's path, since its entries
 * have no identity to carry a key over by: the list is kept whole, or not at all.
 */
const unknownKeys = <S extends Schema.Top>(schema: S, json: Json): ReadonlyArray<FieldPath> => {
  const decoded = decodeValue(schema, json, { errors: "all", onExcessProperty: "error" });
  if (Result.isSuccess(decoded)) return [];
  const paths = decoded.failure
    .filter(({ unexpected }) => unexpected)
    .map(({ path }) => {
      const index = path.findIndex((key) => typeof key === "number");
      return index === -1 ? path : path.slice(0, index);
    });
  return paths.filter(
    (path, index) => path.length > 0 && paths.findIndex((other) => samePath(other, path)) === index,
  );
};

export interface MendedWrite {
  /** The JSON to store. */
  readonly json: Json;
  /** The stored value couldn't be kept around this write, which replaces it whole. */
  readonly replacesUnreadable: boolean;
}

const overlaps = (a: FieldPath, b: FieldPath) =>
  a.slice(0, Math.min(a.length, b.length)).every((key, index) => key === b[index]);

/**
 * What to store for `encoded`, the encoding of the singleton a caller wants written, over `stored`,
 * the text there now. What the read couldn't decode is put back as it was stored unless the caller
 * set it: wherever no path of `touched` reaches, or without `touched`, wherever the caller left the
 * default the read gave in its place. Keys this build doesn't know are kept too, so a write never
 * overwrites what this build couldn't read without being asked to.
 */
export const mendedWrite = <S extends Schema.Top>(
  schema: S,
  defaults: S["Type"],
  encodedDefaults: Json,
  stored: string | undefined,
  encoded: Json,
  touched?: ReadonlyArray<FieldPath>,
): MendedWrite => {
  if (stored === undefined || !isObject(encoded))
    return { json: encoded, replacesUnreadable: false };
  const { mended } = decodeMended(schema, defaults, encodedDefaults, stored);
  if (mended.some((path) => path.length === 0)) return { json: encoded, replacesUnreadable: true };
  const raw = JSON.parse(stored) as Record<PropertyKey, Json>;
  const out = structuredClone(encoded);
  for (const path of mended) {
    if (touched === undefined) {
      if (sameJson(getAt(out, path), getAt(encodedDefaults, path))) {
        setAt(out, path, getAt(raw, path));
      }
      continue;
    }
    // Set whole, or from above: the caller's value stands.
    if (touched.some((set) => set.length <= path.length && overlaps(set, path))) continue;
    // Set inside it: what was stored, with only those paths taken from the caller. The rest of the
    // caller's part is the defaults the read stood in with, which would drop readable siblings.
    const inside = touched.filter((set) => set.length > path.length && overlaps(set, path));
    const kept = getAt(raw, path);
    if (inside.length > 0 && !isObject(kept)) continue;
    const set = inside.map((at) => [at, getAt(out, at)] as const);
    setAt(out, path, kept);
    for (const [at, value] of set) setDeep(out, at, value);
  }
  const unknown = unknownKeys(schema, raw);
  // What the read gave, encoded, to tell a list the caller left alone from one it changed.
  const read =
    unknown.length === 0
      ? undefined
      : encodeValue(schema, decodeMended(schema, defaults, encodedDefaults, stored).value);
  for (const path of unknown) {
    // Set or cleared by the caller: its value stands, even one that leaves the key out.
    if (touched?.some((set) => overlaps(set, path))) continue;
    const now = getAt(out, path);
    if (now === undefined) setAt(out, path, getAt(raw, path));
    else if (Array.isArray(now) && sameJson(now, getAt(read, path))) {
      setAt(out, path, getAt(raw, path));
    }
  }
  return { json: out, replacesUnreadable: false };
};

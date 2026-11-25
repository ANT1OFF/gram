const isPlainObject = (value: object): value is Readonly<Record<string, unknown>> => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const sameData = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((each, i) => sameData(each, b[i]));
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    for (const each of a) if (!b.has(each)) return false;
    return true;
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !sameData(value, b.get(key))) return false;
    return true;
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]));
};

/**
 * `next`, or `previous` when the two are `sameData`: the reference to hand out from a derivation
 * that is recomputed more often than its result changes.
 */
export const keepSame = <T>(previous: T | undefined, next: T): T =>
  previous !== undefined && sameData(previous, next) ? previous : next;

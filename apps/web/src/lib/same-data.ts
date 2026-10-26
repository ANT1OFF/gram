// Whether two values derived from the stores say the same thing, so a view that derives a list on
// every store change can keep the list it had, and with it every component that reads it, still.

/**
 * Deep equality over plain data: primitives, arrays, plain objects, `Set`s and `Map`s. Anything
 * else (a function, a class instance, a `Date`) is the same only as the very same reference, so a
 * value carrying one is never mistaken for an equal one.
 */
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
  const proto = Object.getPrototypeOf(a) as unknown;
  if ((proto !== Object.prototype && proto !== null) || Object.getPrototypeOf(b) !== proto) {
    return false;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key]));
};

/**
 * `next`, or `previous` when the two are `sameData`: the reference to hand out from a derivation
 * that is recomputed more often than its result changes.
 */
export const keepSame = <T>(previous: T | undefined, next: T): T =>
  previous !== undefined && sameData(previous, next) ? previous : next;

import type { DialNonceStore } from "./paired-machines.ts";

/** How one dial's nonce was taken: only `ok` lets the dial in. */
export type NonceRecorded = "ok" | "stale" | "replayed" | "full" | "unsaved";

export interface DialNonceLimits {
  /** How far a dial's signed time may be from this clock: its nonce is kept that long past it. */
  readonly skewMs: number;
  /** The most nonces kept at once, across every key. */
  readonly most: number;
  /** The most of one key's dials in their window at once, so one key can't fill the room. */
  readonly perKey: number;
}

/**
 * The accepted dials' nonces, kept across restarts through `store`, as a signed dial is good for
 * whoever holds its headers until its window passes. A dial at or before `floor` (the latest
 * signed time of any nonce let go, or of a history that couldn't be read) is never taken, so a
 * clock set back can't bring a forgotten dial back. While the history can't be read at all, and
 * nothing bounds it, no dial is taken (`ready` is false).
 */
export const makeDialNonceRecord = (
  store: DialNonceStore,
  now: () => number,
  limits: DialNonceLimits,
) => {
  const nonces = new Map<string, number>();
  let floor = 0;
  let seen = 0;
  const load = () => {
    try {
      const kept = store.read();
      ({ floor, seen } = kept);
      for (const [nonce, until] of kept.nonces) nonces.set(nonce, until);
      return true;
    } catch {
      const last = store.lastSeen?.();
      if (last === undefined) return false;
      floor = Math.max(now(), last) + limits.skewMs;
      seen = floor;
      return true;
    }
  };
  let blind = !load();
  const dialsOf = new Map<string, number[]>();
  return {
    /** Whether a dial signed at `signed` is too old to take whatever its nonce. */
    stale: (signed: number): boolean => signed <= floor,
    /** Whether the history is known; tries to read it again when it wasn't. */
    ready: (): boolean => {
      if (blind) blind = !load();
      return !blind;
    },
    /** Forgets what one key's dials count toward its share, as its machine leaves. */
    forget: (key: string): void => {
      dialsOf.delete(key);
    },
    /** Takes `nonce` of a dial by `key` signed at `signed`, now `at`, if it is new. */
    record: (key: string, nonce: string, signed: number, at: number): NonceRecorded => {
      const until = signed + limits.skewMs;
      const own = (dialsOf.get(key) ?? []).filter((expires) => expires >= at);
      for (const [kept, expires] of nonces)
        if (expires < at) {
          nonces.delete(kept);
          floor = Math.max(floor, expires - limits.skewMs);
        }
      if (signed <= floor) return "stale";
      if (nonces.has(nonce)) return "replayed";
      if (nonces.size >= limits.most || own.length >= limits.perKey) return "full";
      dialsOf.set(key, [...own, until]);
      nonces.set(nonce, until);
      seen = Math.max(seen, at);
      try {
        store.write({ nonces: [...nonces], floor, seen });
      } catch {
        return "unsaved";
      }
      return "ok";
    },
  };
};

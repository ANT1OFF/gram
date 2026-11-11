import { createPublicKey, type KeyObject } from "node:crypto";
import { DEVICE_GRANT_TTL_MS, type SignedTurnGrant } from "@gram/contracts";
import { mintTurnGrant, turnGrantHolds } from "./keys.ts";

/**
 * The grants this device has minted and still honours. A grant's signature says the device made
 * it; this list says the device made it in this run of the app and hasn't taken it back. It is
 * kept in memory only, so no grant outlives a quit, and a grant for a thread is gone the moment
 * lending stops or the person signs out.
 */

export interface GrantTarget {
  readonly origin: string;
  readonly workspace: string;
  readonly thread: string;
}

/** More live grants than this and the oldest go: a person doesn't write to this many threads. */
export const GRANTS_MOST = 256;

export interface GrantLedger {
  /** A grant for a message the person is sending to `to` now. */
  readonly mint: (to: GrantTarget) => SignedTurnGrant;
  /** Whether a request's grant is one of these, for exactly this thread, and still in its time. */
  readonly holds: (signed: SignedTurnGrant, expected: GrantTarget) => boolean;
  /** Takes back every grant for a thread, a workspace or a whole server. */
  readonly withdraw: (from: Partial<GrantTarget>) => void;
  readonly size: () => number;
}

/**
 * `now` is the wall clock a grant is signed with. `elapsed` is a clock that only goes forward:
 * a grant also ends by it, so setting the wall clock back doesn't stretch one.
 */
export const makeGrantLedger = (
  key: KeyObject,
  now: () => number,
  elapsed: () => number = () => performance.now(),
): GrantLedger => {
  const publicKey = createPublicKey(key);
  /** By nonce, in the order minted. */
  const live = new Map<string, { readonly to: GrantTarget; readonly endsAt: number }>();
  const prune = () => {
    const time = elapsed();
    for (const [nonce, grant] of live) if (!(time < grant.endsAt)) live.delete(nonce);
  };
  return {
    mint: (to) => {
      prune();
      const signed = mintTurnGrant(key, to, now());
      live.set(signed.grant.nonce, { to: { ...to }, endsAt: elapsed() + DEVICE_GRANT_TTL_MS });
      for (const nonce of live.keys()) {
        if (live.size <= GRANTS_MOST) break;
        live.delete(nonce);
      }
      return signed;
    },
    holds: (signed, expected) => {
      prune();
      const nonce = signed?.grant?.nonce;
      const minted = typeof nonce === "string" ? live.get(nonce) : undefined;
      if (minted === undefined) return false;
      if (
        minted.to.origin !== expected.origin ||
        minted.to.workspace !== expected.workspace ||
        minted.to.thread !== expected.thread
      )
        return false;
      return turnGrantHolds(publicKey, signed, expected, now());
    },
    withdraw: (from) => {
      for (const [nonce, { to }] of live)
        if (
          (from.origin === undefined || from.origin === to.origin) &&
          (from.workspace === undefined || from.workspace === to.workspace) &&
          (from.thread === undefined || from.thread === to.thread)
        )
          live.delete(nonce);
    },
    size: () => {
      prune();
      return live.size;
    },
  };
};

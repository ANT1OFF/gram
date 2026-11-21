import {
  type Checkout,
  effectiveCheckout,
  type HostId,
  hostOf,
  LOCAL_HOST_ID,
  type Thread,
} from "@gram/contracts";
import { samePathKey } from "@gram/git";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { folderExists } from "../fs/folders.ts";
import { forThread } from "../embedding/gh-thread.ts";
import { githubRelayed } from "../embedding/github-relay.ts";

/** Where a checkout is: the machine it is on, and its path there. */
export interface Spot {
  readonly hostId: HostId;
  readonly path: string;
}

export const spotOf = (checkout: Pick<Checkout, "path" | "hostId">): Spot => ({
  hostId: hostOf(checkout),
  path: checkout.path,
});

/**
 * What the publisher keeps a checkout's state under: on this machine its path's `samePathKey`, and
 * on another its machine with its path as written (never looked up on this disk). Two machines can
 * hold the same path, and those are two checkouts.
 */
export const spotKey = (spot: Spot): string =>
  spot.hostId === LOCAL_HOST_ID
    ? samePathKey(spot.path)
    : `${spot.hostId}\u0000${nodePath.resolve(spot.path)}`;

/**
 * Whether a checkout's folder is there, by this disk for this machine's: another machine's is that
 * machine's to say, and its read does.
 */
export const thereHere = (spot: Spot) =>
  spot.hostId === LOCAL_HOST_ID ? folderExists(spot.path) : Effect.succeed(true);

const CHECKOUT_KEY_TTL_MS = 2_000;
const checkoutKeys = new WeakMap<Checkout, { readonly key: string; readonly at: number }>();

/**
 * `spotKey` of the checkout `thread` works in, kept a moment per checkout object. Each refresh
 * and sweep matches every thread against a key, so without it a sweep made a `realpath` (several
 * for a removed worktree) per thread per checkout: quadratic in threads, and synchronous. A thread
 * read again from the store is a new object, and a folder that changed under one is seen within
 * `CHECKOUT_KEY_TTL_MS`.
 */
export const checkoutKey = (thread: Thread): string => {
  const checkout = effectiveCheckout(thread);
  const now = Date.now();
  const kept = checkoutKeys.get(checkout);
  if (kept !== undefined && now - kept.at < CHECKOUT_KEY_TTL_MS) return kept.key;
  const key = spotKey(spotOf(checkout));
  checkoutKeys.set(checkout, { key, at: now });
  return key;
};

/**
 * How the reads of a checkout that `threads` are on go out: `remote`, whether GitHub is read for
 * it at all (as asked, and behind a route only with a thread on it), and `as`, which runs them for
 * the first of those threads by id, so the same checkout is always read for the same one.
 */
export const checkoutReads = (threads: ReadonlyArray<Thread>, remote: boolean) => {
  const owner = threads.map((thread) => thread.id).toSorted()[0];
  return {
    owner,
    remote: remote && (owner !== undefined || !githubRelayed()),
    as:
      owner === undefined ? <A, E, R>(effect: Effect.Effect<A, E, R>) => effect : forThread(owner),
  };
};

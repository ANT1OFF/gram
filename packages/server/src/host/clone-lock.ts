import { samePathKey } from "@gram/git";
import type * as Effect from "effect/Effect";
import { makeKeyedLock } from "../git/keyed-lock.ts";

const clones = makeKeyedLock<string>();

/** Clone refresh, explicit base fetch and worktree creation share the same physical repo key. */
export const withCloneLock = <A, E, R>(path: string, effect: Effect.Effect<A, E, R>) =>
  clones.withLock(samePathKey(path), effect);

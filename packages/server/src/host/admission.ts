import * as Effect from "effect/Effect";

/** Why new work is refused while the gate is closed. */
export const UPDATING = "This machine is updating Gram. Try again in a moment.";

/**
 * Whether the host takes new work: a session opened or handed input, a terminal opened or typed
 * into, a clone, a worktree or a check. An update closes it before its last look at what runs, and
 * keeps it closed until the service stops, so nothing starts between that look and the restart.
 * `inflight` counts work admitted and not yet answered, which a look at what runs may not see yet.
 */
export interface Admission {
  readonly closed: () => boolean;
  readonly inflight: () => number;
  readonly close: () => void;
  readonly open: () => void;
  /** Runs `effect` as admitted work, or fails with `refused()` while the gate is closed. */
  readonly admit: <A, E, R, E2>(
    effect: Effect.Effect<A, E, R>,
    refused: () => E2,
  ) => Effect.Effect<A, E | E2, R>;
}

export const makeAdmission = (): Admission => {
  let closed = false;
  let inflight = 0;
  return {
    closed: () => closed,
    inflight: () => inflight,
    close: () => {
      closed = true;
    },
    open: () => {
      closed = false;
    },
    admit: <A, E, R, E2>(effect: Effect.Effect<A, E, R>, refused: () => E2) =>
      Effect.suspend((): Effect.Effect<A, E | E2, R> => {
        if (closed) return Effect.fail(refused());
        inflight += 1;
        return effect.pipe(Effect.ensuring(Effect.sync(() => (inflight -= 1))));
      }),
  };
};

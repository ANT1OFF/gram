import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/** A shared agent server a session holds for its lifetime. */
export interface Retainable {
  /** Holds the server until the scope closes; false, holding nothing, once `invalidate` retired it. */
  readonly retain: Effect.Effect<boolean, never, Scope.Scope>;
}

/**
 * The server `acquire` gives, held for the calling scope. One retired between `acquire` and the hold
 * (its key rotated) is skipped for the fresh server the next `acquire` starts.
 */
export const acquireHeld = <S extends Retainable, E>(
  acquire: Effect.Effect<S, E>,
): Effect.Effect<S, E, Scope.Scope> =>
  acquire.pipe(
    Effect.flatMap((server) =>
      server.retain.pipe(
        Effect.flatMap((held) => (held ? Effect.succeed(server) : acquireHeld(acquire))),
      ),
    ),
  );

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

export const scopedKeepingFailure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const exit = yield* restore(self.pipe(Scope.provide(scope))).pipe(Effect.exit);
      const closed = yield* Scope.close(scope, exit).pipe(Effect.exit);
      if (Exit.isSuccess(closed)) return yield* exit;
      return yield* Effect.failCause(
        Exit.isFailure(exit) ? Cause.combine(exit.cause, closed.cause) : closed.cause,
      );
    }),
  );

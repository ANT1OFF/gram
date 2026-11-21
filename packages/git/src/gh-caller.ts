import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The environment a `gh` run carries for the caller it is made for; empty for the server's own. */
export const GhCallEnv = Context.Reference<Readonly<Record<string, string>>>(
  "@gram/git/GhCallEnv",
  { defaultValue: () => ({}) },
);

/** A stable key of a caller's environment: `""` for the server's own calls. */
export const ghCallerKey = (env: Readonly<Record<string, string>>): string => {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return JSON.stringify(entries.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

/** The caller key of the running fiber. */
export const currentGhCaller: Effect.Effect<string> = Effect.gen(function* () {
  return ghCallerKey(yield* GhCallEnv);
});

/** The caller environment a request entry was made under. */
export const ghCallEnvOf = (context: Context.Context<never>): Readonly<Record<string, string>> =>
  Context.get(context, GhCallEnv);

/** Runs `effect` for the caller `env` names. */
export const asGhCaller =
  (env: Readonly<Record<string, string>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, GhCallEnv, env);

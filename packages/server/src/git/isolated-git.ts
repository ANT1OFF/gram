import { type ProcError, type ProcOutput, Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { isGitControl } from "./check-process.ts";

/** `git`'s options for such a run, `env` added to it. */
export const isolatedGitOptions = (
  env?: Record<string, string>,
  more?: { readonly stdin?: string; readonly tier?: "local" | "slow" },
) => ({
  ...more,
  omitEnv: isGitControl,
  env: {
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
    ...env,
  },
});

/** A git run on `proc`, `undefined` when it couldn't run (a refused origin among them). */
export const ranOn =
  (proc: ProcShape) =>
  (run: Effect.Effect<ProcOutput, ProcError, Proc>): Effect.Effect<ProcOutput | undefined> =>
    run.pipe(
      Effect.provideService(Proc, proc),
      Effect.option,
      Effect.map((out) => (out._tag === "Some" ? out.value : undefined)),
    );

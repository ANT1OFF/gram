// The one way a shell module runs a command to its end: `Proc` from `@gram/git/proc`, which
// bounds the run, kills an overrun and reaps it. Effect stays inside this
// wrapper; a module sees a Promise.

import { homedir } from "node:os";

import { Proc, ProcLive } from "@gram/git/proc";
import * as Effect from "effect/Effect";

/** Runs a command to completion and resolves with its stdout; rejects on a non-zero exit. */
export type RunCommand = (file: string, args: readonly string[]) => Promise<string>;

/** A `RunCommand` with these bounds, through `Proc`. */
export const boundedRun =
  (bounds: { readonly timeoutMs: number; readonly maxOutputBytes: number }): RunCommand =>
  (file, args) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const proc = yield* Proc;
        return yield* proc.run(file, args, { cwd: homedir(), ...bounds });
      }).pipe(Effect.provide(ProcLive)),
    ).then((out) => {
      if (out.status !== 0) throw new Error(`${file} exited with ${out.status}`);
      if (out.truncated) throw new Error(`${file} wrote more than ${bounds.maxOutputBytes} bytes`);
      return out.stdout;
    });

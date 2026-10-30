import type { Writable } from "node:stream";
import * as Effect from "effect/Effect";

/** Writes one RPC line; the caller owns the pipe's lifetime and its error listener. */
export const writeCodexLine = (input: Writable | null, line: string): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (input === null || input.destroyed || !input.writable) {
      resume(Effect.die(new Error("Codex input pipe is closed")));
      return;
    }
    // write() returning means queued, not delivered. Only its callback observes async EPIPE.
    input.write(`${line}\n`, (error) => {
      resume(error ? Effect.die(error) : Effect.void);
    });
  });

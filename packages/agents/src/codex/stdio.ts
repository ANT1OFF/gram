import { StringDecoder } from "node:string_decoder";
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

/**
 * Reads the app-server's stdout as newline-delimited lines. A UTF-8 character split across two
 * chunks decodes whole, and each chunk is scanned once: a long event arriving in many chunks costs
 * its length, not its length times the chunks it came in.
 */
export const codexLineReader = (emit: (line: string) => void) => {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return (data: Buffer) => {
    const chunk = decoder.write(data);
    let index = chunk.indexOf("\n");
    if (index < 0) {
      pending += chunk;
      return;
    }
    emit(pending + chunk.slice(0, index));
    let start = index + 1;
    while ((index = chunk.indexOf("\n", start)) >= 0) {
      emit(chunk.slice(start, index));
      start = index + 1;
    }
    pending = chunk.slice(start);
  };
};

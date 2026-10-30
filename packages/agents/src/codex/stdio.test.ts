import { describe, expect, it } from "@effect/vitest";
import { Writable } from "node:stream";
import * as Effect from "effect/Effect";
import { writeCodexLine } from "./stdio.ts";

describe("Codex pipe writes", () => {
  it.effect("reports asynchronous write failure instead of acknowledging an answer", () =>
    Effect.gen(function* () {
      const input = new Writable({
        write: (_chunk, _encoding, done) => {
          queueMicrotask(() => done(new Error("synthetic EPIPE")));
        },
      });
      // Match the owned child pipe's permanent error observer.
      input.on("error", () => {});
      const delivered = yield* Effect.exit(writeCodexLine(input, '{"id":19,"result":{}}'));
      expect(delivered._tag).toBe("Failure");
    }),
  );

  it.effect("refuses a missing or closed pipe", () =>
    Effect.gen(function* () {
      const input = new Writable({ write: (_chunk, _encoding, done) => done() });
      input.destroy();
      for (const pipe of [null, input]) {
        const delivered = yield* Effect.exit(writeCodexLine(pipe, "{}"));
        expect(delivered._tag).toBe("Failure");
      }
    }),
  );
});

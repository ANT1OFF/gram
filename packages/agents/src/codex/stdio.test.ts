import { describe, expect, it } from "@effect/vitest";
import { Writable } from "node:stream";
import * as Effect from "effect/Effect";
import { codexLineReader, writeCodexLine } from "./stdio.ts";

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

const read = (chunks: ReadonlyArray<Buffer>) => {
  const lines: string[] = [];
  const reader = codexLineReader((line) => lines.push(line));
  for (const chunk of chunks) reader(chunk);
  return lines;
};

describe("Codex stdout lines", () => {
  it("keeps a character split across two chunks whole", () => {
    const bytes = Buffer.from('{"text":"café …"}\n', "utf8");
    // Every cut point, including inside the two- and three-byte characters.
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(read([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(['{"text":"café …"}']);
    }
  });

  it("splits many lines in a chunk and joins one line over many chunks", () => {
    const long = "x".repeat(10_000);
    const bytes = Buffer.from(`a\nb\n${long}\nc\npartial`, "utf8");
    const chunks = Array.from({ length: Math.ceil(bytes.length / 7) }, (_, i) =>
      bytes.subarray(i * 7, i * 7 + 7),
    );
    expect(read(chunks)).toEqual(["a", "b", long, "c"]);
    expect(read([bytes])).toEqual(["a", "b", long, "c"]);
  });
});

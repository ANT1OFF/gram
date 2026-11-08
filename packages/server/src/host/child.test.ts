import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { spawnLocalHost } from "./child.ts";

describe("the host as its own process", () => {
  it.live(
    "starts, says hello from its own pid, serves this machine's files, and stops with its scope",
    () =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "gram-host-child-"));
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(dir, { recursive: true })));
        writeFileSync(join(dir, "a.txt"), "a\n");
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const host = yield* spawnLocalHost;
            expect(host.hello.pid).not.toBe(process.pid);
            expect(host.hello.capabilities).toEqual(["files", "ports"]);
            const listing = yield* host.files.list(dir, { showHidden: false, limit: 10 });
            expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
            return host.hello.pid;
          }),
        );
        // Gone with the scope: signalling it now finds no such process.
        expect(() => process.kill(pid, 0)).toThrow();
      }).pipe(Effect.scoped),
    30_000,
  );
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { spawnHost, spawnLocalHost } from "./child.ts";

const folder = Effect.acquireRelease(
  Effect.sync(() => {
    const dir = mkdtempSync(join(tmpdir(), "gram-host-child-"));
    writeFileSync(join(dir, "a.txt"), "a\n");
    return dir;
  }),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the host as its own process", () => {
  it.live(
    "starts, says hello from its own pid, serves this machine's files, and stops with its scope",
    () =>
      Effect.gen(function* () {
        const dir = yield* folder;
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
        expect(alive(pid)).toBe(false);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live(
    "fails calls at once after the host process dies, rather than waiting on its stream",
    () =>
      Effect.gen(function* () {
        const dir = yield* folder;
        const host = yield* spawnLocalHost;
        process.kill(host.hello.pid, "SIGKILL");
        yield* Effect.sleep("300 millis");
        expect(host.gone()).toBe(true);
        for (let call = 0; call < 3; call++) {
          const started = Date.now();
          const error = yield* host.files
            .list(dir, { showHidden: false, limit: 10 })
            .pipe(Effect.flip);
          expect(error._tag).toMatch(/HostUnavailable|InvalidState/);
          expect(Date.now() - started).toBeLessThan(1_000);
        }
        const scan = yield* Effect.flip(host.scan);
        expect(scan).toMatchObject({ _tag: "HostUnavailable" });
      }).pipe(Effect.scoped),
    30_000,
  );

  it.live("a host process that can't start is unavailable, and the server carries on", () =>
    Effect.gen(function* () {
      const error = yield* spawnHost({ file: "/nonexistent/gram-host", args: [] }).pipe(
        Effect.flip,
      );
      expect(error._tag).toBe("HostUnavailable");
    }).pipe(Effect.scoped),
  );

  it.live(
    "a host process that never says hello is unavailable after the hello's deadline",
    () =>
      Effect.gen(function* () {
        const error = yield* spawnHost({
          file: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        }).pipe(Effect.flip);
        expect(error.message).toContain("hello in time");
      }).pipe(Effect.scoped),
    30_000,
  );
});

// A machine's recorded checkout claims that folder for the machine, and nothing of this server's:
// not its data folder, nor a folder above this machine's own checkouts.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { type Checkout, HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import { forgetForeignPathsForTest, isForeignPath } from "@gram/git";
import * as Effect from "effect/Effect";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  claimableByHost,
  forgetOwnFoldersForTest,
  keepFoldersHere,
  noteForeignCheckouts,
} from "./foreign-paths.ts";
import { placedHost } from "./placed.ts";
import type { WorkerHost } from "./worker-host.ts";

const MACHINE = HostId.make("m-0123456789abcdef01234567");
const DATA = "/var/lib/gram-data";
const LOCAL_PATH = "/Users/me/widgets";
const REMOTE_PATH = "/srv/gram-host/repos/.threads/t-fine";

const thread = (id: string, checkout: Checkout) =>
  ({ id: ThreadId.make(id), checkout }) as unknown as Thread;

const placedWith = (threads: ReadonlyArray<Thread>) =>
  placedHost(
    {
      local: {} as unknown as WorkerHost,
      get: () => Effect.succeed({} as unknown as WorkerHost),
    },
    {
      listThreads: Effect.succeed(threads),
      getThread: () => Effect.die(new Error("not in this test")),
    },
  );

afterEach(() => {
  forgetForeignPathsForTest();
  forgetOwnFoldersForTest();
});

describe("a machine's recorded folder", () => {
  it.effect("routes and marks only what is the machine's, never this server's folders", () =>
    Effect.gen(function* () {
      keepFoldersHere([DATA]);
      const placed = placedWith([
        thread("t-root", { kind: "main", path: "/", hostId: MACHINE }),
        thread("t-users", { kind: "main", path: "/Users", hostId: MACHINE }),
        thread("t-fine", { kind: "main", path: REMOTE_PATH, hostId: MACHINE }),
        thread("t-local", { kind: "main", path: LOCAL_PATH }),
      ]);
      expect(yield* placed.placeOf(`${DATA}/threads.db`)).toBe(LOCAL_HOST_ID);
      expect(yield* placed.placeOf(`${LOCAL_PATH}/src`)).toBe(LOCAL_HOST_ID);
      expect(yield* placed.placeOf("/Users/someone-else")).toBe(LOCAL_HOST_ID);
      expect(yield* placed.placeOf(`${REMOTE_PATH}/notes.md`)).toBe(MACHINE);
      expect(isForeignPath(`${DATA}/threads.db`)).toBe(false);
      expect(isForeignPath(REMOTE_PATH)).toBe(true);
    }),
  );

  it.effect(
    "never marks as another machine's a folder that is, holds or lies under a local checkout",
    () =>
      Effect.gen(function* () {
        // The machine's threads come first, so their marks are made before the local checkout is read.
        const placed = placedWith([
          thread("t-same", { kind: "main", path: LOCAL_PATH, hostId: MACHINE }),
          thread("t-above", { kind: "main", path: "/Users/me", hostId: MACHINE }),
          thread("t-below", { kind: "main", path: `${LOCAL_PATH}/vendor`, hostId: MACHINE }),
          thread("t-fine", { kind: "main", path: REMOTE_PATH, hostId: MACHINE }),
          thread("t-local", { kind: "main", path: LOCAL_PATH }),
        ]);
        yield* placed.placeOf(`${LOCAL_PATH}/src`);
        for (const path of [
          LOCAL_PATH,
          `${LOCAL_PATH}/src/link`,
          "/Users/me",
          `${LOCAL_PATH}/vendor`,
        ])
          expect(isForeignPath(path)).toBe(false);
        expect(isForeignPath(REMOTE_PATH)).toBe(true);
        // And a thread read on its own, after the local checkout is known, marks none of them.
        noteForeignCheckouts(
          thread("t-later", { kind: "main", path: `${LOCAL_PATH}/x`, hostId: MACHINE }),
        );
        expect(isForeignPath(`${LOCAL_PATH}/x`)).toBe(false);
        expect(yield* placed.placeOf(`${LOCAL_PATH}/vendor/lib.ts`)).not.toBe(MACHINE);
      }),
  );

  it("keeps a folder of this server's by its real path and from a relative one", () => {
    const dir = mkdtempSync(join(tmpdir(), "gram-own-"));
    try {
      const real = join(dir, "vol", "gram");
      mkdirSync(real, { recursive: true });
      const link = join(dir, "gram");
      symlinkSync(real, link);
      keepFoldersHere([link, "relative-data"]);
      for (const path of [real, `${real}/threads`, resolve("relative-data"), `${link}/x`]) {
        expect(claimableByHost(path)).toBe(false);
        noteForeignCheckouts(thread("t-host", { kind: "main", path, hostId: MACHINE }));
        expect(isForeignPath(path)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A machine's recorded checkout claims that folder for the machine, and nothing of this server's:
// not its data folder, nor a folder above this machine's own checkouts.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { type Checkout, HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import { forgetForeignPathsForTest, isForeignPath } from "@gram/git";
import * as Effect from "effect/Effect";
import { forgetOwnFoldersForTest, keepFoldersHere } from "./foreign-paths.ts";
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
});

// A workspace of hundreds of threads, most of them on other machines and some whose local
// worktree is gone: reading the threads and placing paths must not ask the disk per thread per
// read. The server once spent every second of the event loop realpath-ing deleted worktrees.

import { afterEach, describe, expect, it } from "@effect/vitest";
import { type Checkout, HostId, LOCAL_HOST_ID, type Thread, ThreadId } from "@gram/contracts";
import { forgetForeignPathsForTest, isForeignPath } from "@gram/git";
import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forgetOwnFoldersForTest,
  keepServerFolders,
  noteForeignCheckouts,
} from "./foreign-paths.ts";
import { placedHost } from "./placed.ts";
import type { WorkerHost } from "./worker-host.ts";

const MACHINES = [0, 1, 2].map((i) => HostId.make(`m-${String(i).repeat(24)}`));
const REMOTE = 300;
const GONE = 100;

const thread = (id: string, checkout: Checkout, extra: ReadonlyArray<Checkout> = []) =>
  ({
    id: ThreadId.make(id),
    checkout,
    extraCheckouts: extra,
  }) as unknown as Thread;

const workspace = (dir: string): ReadonlyArray<Thread> => {
  const repo = join(dir, "repo");
  fs.mkdirSync(join(repo, ".worktrees", "live"), { recursive: true });
  const threads: Array<Thread> = [];
  for (let i = 0; i < REMOTE; i++) {
    const hostId = MACHINES[i % MACHINES.length]!;
    const repoRoot = `/srv/gram-host/m${i % MACHINES.length}/r${i % 7}`;
    threads.push(
      thread(`t-remote-${i}`, {
        kind: "worktree",
        path: `${repoRoot}/.worktrees/t-${i}`,
        repoRoot,
        hostId,
      } as Checkout),
    );
  }
  // Local worktrees that were removed: their folders are on no disk now.
  for (let i = 0; i < GONE; i++)
    threads.push(
      thread(`t-gone-${i}`, {
        kind: "worktree",
        path: join(repo, ".worktrees", `gone-${i}`),
        repoRoot: repo,
      } as Checkout),
    );
  threads.push(
    thread("t-live", {
      kind: "worktree",
      path: join(repo, ".worktrees", "live"),
      repoRoot: repo,
    } as Checkout),
  );
  return threads;
};

afterEach(() => {
  forgetForeignPathsForTest();
  forgetOwnFoldersForTest();
});

describe("many threads on many machines", () => {
  it.effect("are read and placed without a realpath per thread per read", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(join(tmpdir(), "gram-many-"));
      try {
        // Kept before the server makes it, as at start.
        keepServerFolders(join(dir, "data"));
        fs.mkdirSync(join(dir, "data"));
        const threads = workspace(dir);
        let current: ReadonlyArray<Thread> = threads;
        const placed = placedHost(
          {
            local: {} as unknown as WorkerHost,
            get: () => Effect.succeed({} as unknown as WorkerHost),
          },
          {
            listThreads: Effect.sync(() => current),
            getThread: () => Effect.die(new Error("not in this test")),
          },
        );
        // The first read notes every thread: that much asks the disk once.
        for (const each of threads) noteForeignCheckouts(each);
        expect(yield* placed.placeOf("/srv/gram-host/m1/r1/.worktrees/t-1/a.ts")).toBe(MACHINES[1]);

        const native = fs.realpathSync.native;
        let calls = 0;
        fs.realpathSync.native = ((...args: Parameters<typeof native>) => {
          calls++;
          return native(...args);
        }) as typeof native;
        const ROUNDS = 20;
        let readCalls = 0;
        const cpu = process.cpuUsage();
        try {
          for (let round = 0; round < ROUNDS; round++) {
            // A list read, then placing paths over a list that changed, as a live thread's every
            // event makes it.
            const before = calls;
            for (const each of threads) noteForeignCheckouts(each);
            readCalls += calls - before;
            current = [...threads];
            expect(yield* placed.placeOf(`/srv/gram-host/m${round % 3}/r${round % 7}/x`)).toBe(
              MACHINES[round % 3],
            );
            expect(yield* placed.placeOf(join(dir, "repo", ".worktrees", "live", "a.ts"))).toBe(
              LOCAL_HOST_ID,
            );
          }
        } finally {
          fs.realpathSync.native = native;
        }
        const used = process.cpuUsage(cpu);
        // Reading threads looks again only at a removed worktree whose wait is up: a handful of
        // looks each in a minute, however often the threads are read. It was GONE per thread read.
        expect(readCalls).toBeLessThanOrEqual(GONE * 6);
        // Placing asks the disk about this machine's own checkouts once each, not per thread on
        // other machines. It was about 120,000 a round, near 4 s of CPU.
        expect(calls - readCalls).toBeLessThanOrEqual(ROUNDS * 5 * (GONE + 1));
        expect((used.user + used.system) / 1000).toBeLessThan(5_000);
        expect(isForeignPath("/srv/gram-host/m1/r1/.worktrees/t-1")).toBe(true);
        expect(isForeignPath(join(dir, "repo", ".worktrees", "gone-1"))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});

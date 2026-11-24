// A thread list with many machines' checkouts and deleted local worktrees: reading it, placing a
// path on it and reading each thread again must not ask this disk about every kept folder for
// every path. The stall this guards: the server at full CPU in realpath, the app "reconnecting".

import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { type Checkout, HostId, type Thread, ThreadId } from "@gram/contracts";
import { forgetForeignPathsForTest } from "@gram/git";
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

const REMOTE = 300;
const DELETED = 100;

const threadsOn = (base: string): ReadonlyArray<Thread> => {
  const repo = join(base, "repo");
  const threads: Array<Thread> = [];
  for (let i = 0; i < REMOTE; i += 1) {
    const hostId = HostId.make(`m-${String(i % 3).padStart(24, "0")}`);
    const checkout: Checkout = {
      kind: "worktree",
      path: `/srv/gram-host/repos/widgets/.worktrees/t-${i}`,
      repoRoot: "/srv/gram-host/repos/widgets",
      hostId,
    } as unknown as Checkout;
    threads.push({ id: ThreadId.make(`t-remote-${i}`), checkout } as unknown as Thread);
  }
  for (let i = 0; i < DELETED; i += 1) {
    const checkout = {
      kind: "worktree",
      path: join(repo, ".worktrees", `gone-${i}`),
      repoRoot: repo,
    } as unknown as Checkout;
    threads.push({ id: ThreadId.make(`t-gone-${i}`), checkout } as unknown as Thread);
  }
  return threads;
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  forgetForeignPathsForTest();
  forgetOwnFoldersForTest();
});

describe("a long thread list with other machines' checkouts and deleted worktrees", () => {
  it.effect("is read, placed and read again without a realpath per kept folder per path", () =>
    Effect.gen(function* () {
      // Time stands still, so no retry of a folder that isn't there falls due mid-round.
      vi.useFakeTimers({ toFake: ["Date"] });
      const base = fs.mkdtempSync(join(tmpdir(), "gram-load-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(base, { recursive: true, force: true })),
      );
      fs.mkdirSync(join(base, "repo", ".worktrees"), { recursive: true });
      // The data folder isn't there yet, as on a first start: it stays pending too.
      keepServerFolders(join(base, "data"));
      const threads = threadsOn(base);
      const placed = placedHost(
        {
          local: {} as unknown as WorkerHost,
          get: () => Effect.succeed({} as unknown as WorkerHost),
        },
        // A fresh array each time, as a list read after a write gives.
        {
          listThreads: Effect.sync(() => [...threads]),
          getThread: () => Effect.die(new Error("not in this test")),
        },
      );
      // One round: the list read notes every thread, a placement keys them all, and each thread
      // is read again on its own (as `readThread` does on every update).
      const round = Effect.gen(function* () {
        for (const thread of threads) noteForeignCheckouts(thread);
        yield* placed.placeOf(join(base, "repo", "src"));
        for (const thread of threads) noteForeignCheckouts(thread);
      });
      yield* round;

      const realpath = vi.spyOn(fs.realpathSync, "native");
      const cpu = process.cpuUsage();
      yield* round;
      const used = process.cpuUsage(cpu);
      const calls = realpath.mock.calls.length;
      const cpuMs = (used.user + used.system) / 1_000;
      console.info(`realpath load: ${calls} realpaths, ${cpuMs.toFixed(1)} ms CPU per round`);

      realpath.mockClear();
      for (const thread of threads) noteForeignCheckouts(thread);
      const onReads = realpath.mock.calls.length;

      // Half a minute on, the folders that aren't there are asked about once each, not per path.
      vi.advanceTimersByTime(30_000);
      realpath.mockClear();
      for (const thread of threads) noteForeignCheckouts(thread);
      const retries = realpath.mock.calls.length;

      // Before this guard: 187,703 realpaths and about 13 s of CPU per round.
      expect(calls).toBeLessThan(1_000);
      expect(cpuMs).toBeLessThan(500);
      expect(onReads).toBe(0);
      expect(retries).toBeLessThanOrEqual(DELETED + 1);
    }),
  );
});

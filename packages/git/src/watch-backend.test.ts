import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { Proc, ProcLive } from "./proc.ts";
import { removeDir, tempDir, write } from "./test-utils.ts";
import {
  FSEVENTS_RESTART_SETTLE_MS,
  defaultBackend,
  isIgnored,
  isWatchLimitError,
  parcelIgnore,
  subscribeRoot,
  type RootIgnore,
} from "./watch.ts";

// Only the lifecycle regression replaces this implementation. The native smoke cases below
// call the original API, as do the separate real Git-state/edit/commit integration tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

const topIgnore: RootIgnore = { topLevel: [".git"], anyDepth: ["node_modules"] };

const dropEvents = () => undefined;

const sleep = (millis: number) => new Promise((resolve) => setTimeout(resolve, millis));

const until = async (done: () => boolean, millis: number) => {
  const deadline = Date.now() + millis;
  while (!done() && Date.now() < deadline) {
    await sleep(20);
  }
};

const hasParcel = await import("@parcel/watcher").then(
  () => true,
  () => false,
);

describe("watch backends", () => {
  const dirs: Array<string> = [];
  afterEach(async () => {
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    Object.defineProperty(process, "platform", platform);
    vi.mocked(fs.watch).mockReset();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it("uses fs.watch on Windows and macOS and @parcel/watcher on Linux", () => {
    expect(defaultBackend("win32")).toBe("node");
    expect(defaultBackend("darwin")).toBe("node");
    expect(defaultBackend("linux")).toBe("parcel");
  });

  it("drops ignored paths with either separator", () => {
    expect(isIgnored(".git", topIgnore)).toBe(true);
    expect(isIgnored(".git\\index", topIgnore)).toBe(true);
    expect(isIgnored("src/.git", topIgnore)).toBe(false);
    expect(isIgnored("node_modules", topIgnore)).toBe(true);
    expect(isIgnored("a\\node_modules\\b.js", topIgnore)).toBe(true);
    expect(isIgnored("src/main.ts", topIgnore)).toBe(false);
    expect(isIgnored("", topIgnore)).toBe(false);
    expect(parcelIgnore(topIgnore)).toEqual([".git", "**/node_modules"]);
  });

  it.skipIf(process.platform !== "linux" || !hasParcel)(
    "releases repeated parcel watches without spawning watchman or leaving zombies",
    async () => {
      const dir = tempDir();
      dirs.push(dir);
      const bin = nodePath.join(dir, "bin");
      fs.mkdirSync(bin);
      const probe = nodePath.join(dir, "watchman-probed");
      // The old default backend invoked this missing-command stand-in and leaked its exit-127 shell.
      fs.writeFileSync(nodePath.join(bin, "watchman"), `#!/bin/sh\n: > '${probe}'\nexit 127\n`, {
        mode: 0o755,
      });
      const source = `
        import * as fs from 'node:fs';
        import { subscribeRoot } from ${JSON.stringify(new URL("./watch.ts", import.meta.url).href)};
        const zombies = () => fs.readdirSync('/proc').flatMap(pid => {
          if (!/^\\d+$/.test(pid)) return [];
          try {
            const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            return fields[0] === 'Z' && Number(fields[1]) === process.pid ? [pid] : [];
          } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
            throw error;
          }
        });
        const before = zombies();
        let edits = 0;
        for (let round = 0; round < 3; round++) {
          const release = await subscribeRoot('parcel', process.cwd(), { topLevel: [], anyDepth: [] }, paths => {
            if (paths?.some(path => path.endsWith('/edit.txt'))) edits++;
          });
          try {
            const deadline = Date.now() + 3000;
            const previous = edits;
            while (edits === previous && Date.now() < deadline) {
              fs.writeFileSync('edit.txt', String(Date.now()));
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            if (edits === previous) throw new Error('watch delivered no edit');
          } finally {
            await release();
          }
        }
        console.log(JSON.stringify({ before, after: zombies(), edits }));
      `;
      // Isolate any native popen leak from the test runner; Proc bounds and reaps this child.
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const proc = yield* Proc;
          return yield* proc.run(process.execPath, ["--input-type=module", "--eval", source], {
            cwd: dir,
            env: { PATH: bin },
            timeoutMs: 12_000,
          });
        }).pipe(Effect.provide(ProcLive)),
      );
      expect(out.status, out.stderr).toBe(0);
      const result = JSON.parse(out.stdout) as {
        before: Array<string>;
        after: Array<string>;
        edits: number;
      };
      expect(result.after).toEqual(result.before);
      expect(result.edits).toBeGreaterThanOrEqual(3);
      expect(fs.existsSync(probe)).toBe(false);
    },
  );

  it("survives rapid subscribe, write and release rounds, then still reports edits", async () => {
    // Run before native cases so a real restart timer cannot cross into this test's fake clock.
    // Native closes alone took 24.4 s under CPU load, and FSEvents can drop/coalesce edits.
    // Drive the native callback boundary directly: all 50 lifecycles and every filter assertion
    // remain, with no repeated writes, polling or dependence on the OS's scheduling latency.
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "darwin" });
    const dir = tempDir();
    dirs.push(dir);
    const watches: Array<{ close: ReturnType<typeof vi.fn>; emit: fs.WatchListener<string> }> = [];
    vi.mocked(fs.watch).mockImplementation((...args: Array<unknown>) => {
      const close = vi.fn();
      watches.push({ close, emit: args[2] as fs.WatchListener<string> });
      return { close, on: vi.fn().mockReturnThis() } as unknown as fs.FSWatcher;
    });
    const releasedListeners: Array<ReturnType<typeof vi.fn>> = [];
    for (let round = 0; round < 50; round++) {
      const listener = vi.fn();
      const release = await subscribeRoot("node", dir, topIgnore, listener);
      try {
        expect(fs.watch).toHaveBeenLastCalledWith(
          dir,
          { recursive: true, persistent: false },
          expect.any(Function),
        );
        const relative = `churn-${round % 4}.txt`;
        write(nodePath.join(dir, relative), String(round));
        watches.at(-1)!.emit("change", relative);
        expect(listener).toHaveBeenCalledExactlyOnceWith([nodePath.join(dir, relative)]);
      } finally {
        await release();
      }
      releasedListeners.push(listener);
    }

    const seen: Array<string> = [];
    const release = await subscribeRoot("node", dir, topIgnore, (paths) => {
      if (paths) seen.push(...paths);
    });
    try {
      for (const relative of [
        nodePath.join(".git", "index"),
        nodePath.join("node_modules", "dep.js"),
        nodePath.join("src", "edit.txt"),
      ]) {
        write(nodePath.join(dir, relative), "edit");
        watches.at(-1)!.emit("change", relative);
      }
      await vi.advanceTimersByTimeAsync(FSEVENTS_RESTART_SETTLE_MS);
      const sawEdit = () => seen.some((p) => nodePath.basename(p) === "edit.txt");
      expect(sawEdit()).toBe(true);
      expect(seen.filter((p) => /[\\/](\.git|node_modules)([\\/]|$)/.test(p))).toEqual([]);
      expect(seen).toEqual([nodePath.join(dir, "src", "edit.txt")]);
      // A restart notice must never reach any of the 50 listeners whose scope already ended.
      for (const listener of releasedListeners) expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      await release();
    }
    expect(fs.watch).toHaveBeenCalledTimes(51);
    for (const { close } of watches) expect(close).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  // Keep native admission/write/release coverage here, without timing 50 synchronous FSEvents
  // closes in one test. A raw native subscription promises no readiness or delivery fence;
  // watchGitState's real edit/commit tests cover the observable state, including reconciliation.
  for (const backend of process.platform === "win32"
    ? ["node" as const]
    : (["node", "parcel"] as const))
    it(`subscribes, writes and releases three native rounds (${backend})`, async () => {
      const dir = tempDir();
      dirs.push(dir);
      for (let round = 0; round < 3; round++) {
        const release = await subscribeRoot(backend, dir, topIgnore, dropEvents);
        // Subscribe before release: the real Node handle announces closure on the next tick.
        const closed =
          backend === "node"
            ? new Promise<void>((resolve) =>
                vi.mocked(fs.watch).mock.results.at(-1)!.value.once("close", resolve),
              )
            : undefined;
        try {
          const path = nodePath.join(dir, `native-${round}.txt`);
          write(path, String(round));
          expect(fs.readFileSync(path, "utf8")).toBe(String(round));
        } finally {
          await release();
          await closed;
        }
      }
      if (backend === "node") expect(fs.watch).toHaveBeenCalledTimes(3);
    });

  it.skipIf(process.platform !== "darwin")(
    "tells live fs.watch listeners events may be lost after another watch starts or closes",
    async () => {
      const live = tempDir();
      const other = tempDir();
      dirs.push(live, other);
      let lost = 0;
      const releaseLive = await subscribeRoot("node", live, topIgnore, (paths) => {
        if (paths === undefined) lost++;
      });
      await sleep(FSEVENTS_RESTART_SETTLE_MS * 3);
      lost = 0;

      const releaseOther = await subscribeRoot("node", other, topIgnore, dropEvents);
      await releaseOther();
      await until(() => lost > 0, 5_000);
      await sleep(FSEVENTS_RESTART_SETTLE_MS * 3);
      await releaseLive();
      // One coalesced notice for the start and close together.
      expect(lost).toBe(1);
    },
  );
});

describe("isWatchLimitError", () => {
  it("knows the OS's watch limit, in Node's words, parcel's or a wrapped cause", () => {
    expect(isWatchLimitError(Object.assign(new Error("watch"), { code: "ENOSPC" }))).toBe(true);
    expect(isWatchLimitError(Object.assign(new Error("watch"), { code: "EMFILE" }))).toBe(true);
    expect(
      isWatchLimitError(new Error("inotify_add_watch on '/r' failed: No space left on device")),
    ).toBe(true);
    expect(
      isWatchLimitError(
        new Error("wrapped", { cause: new Error("inotify_init1: Too many open files") }),
      ),
    ).toBe(true);
  });

  it("leaves other failures to the quiet path", () => {
    expect(
      isWatchLimitError(new Error("inotify_add_watch on '/r' failed: Permission denied")),
    ).toBe(false);
    expect(isWatchLimitError(undefined)).toBe(false);
  });
});

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { Proc, ProcLive } from "./proc.ts";
import { removeDir, tempDir, write } from "./test-utils.ts";
import {
  FSEVENTS_RESTART_SETTLE_MS,
  defaultBackend,
  isIgnored,
  parcelIgnore,
  subscribeRoot,
  type RootIgnore,
} from "./watch.ts";

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
  afterEach(() => {
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
    const dir = tempDir();
    dirs.push(dir);
    for (let round = 0; round < 50; round++) {
      const release = await subscribeRoot("node", dir, topIgnore, dropEvents);
      write(nodePath.join(dir, `churn-${round % 4}.txt`), String(round));
      await release();
    }

    const seen: Array<string> = [];
    const release = await subscribeRoot("node", dir, topIgnore, (paths) => {
      if (paths) seen.push(...paths);
    });
    const sawEdit = () => seen.some((p) => nodePath.basename(p) === "edit.txt");
    // `fs.watch` returns before libuv has restarted its FSEvents stream, and the new stream starts
    // from "now": a write that beats the restart is never delivered, however long the wait. A loaded
    // macos-14 runner lost that race with a single write, so every poll writes again, ignored paths
    // first so they are as deliverable as the edit that ends the loop.
    let attempt = 0;
    await until(() => {
      if (sawEdit()) return true;
      attempt++;
      write(nodePath.join(dir, ".git", "index"), `ignored ${attempt}`);
      write(nodePath.join(dir, "node_modules", "dep.js"), `ignored ${attempt}`);
      write(nodePath.join(dir, "src", "edit.txt"), `seen ${attempt}`);
      return false;
    }, 20_000);
    await release();
    expect(sawEdit()).toBe(true);
    expect(seen.filter((p) => /[\\/](\.git|node_modules)([\\/]|$)/.test(p))).toEqual([]);
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

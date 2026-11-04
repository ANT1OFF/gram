import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { checkpointRef, diffBetween, snapshotCheckpoint } from "./checkpoints.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";

const provide = Effect.provide(ProcLive);

describe.skipIf(!hasGit)("per-turn checkpoint diffs", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  it.live("a turn's diff holds only that turn's edits, and a running turn diffs the tree", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const repo = makeRepo(dir);
      const thread = "thread-1";
      const paths = (from: string, to: string) =>
        diffBetween(repo, from, to).pipe(Effect.map((d) => d.files.map((f) => f.path).toSorted()));

      yield* snapshotCheckpoint(repo, thread, "turn-1");
      write(nodePath.join(repo, "tracked.txt"), "edited in turn 1\n");
      yield* snapshotCheckpoint(repo, thread, "turn-1.end");

      yield* snapshotCheckpoint(repo, thread, "turn-2");
      write(nodePath.join(repo, "src", "two.ts"), "export const two = 2;\n");
      write(nodePath.join(repo, "tracked.txt"), "edited again in turn 2\n");
      yield* snapshotCheckpoint(repo, thread, "turn-2.end");

      expect(
        yield* paths(checkpointRef(thread, "turn-1"), checkpointRef(thread, "turn-1.end")),
      ).toEqual(["tracked.txt"]);
      expect(
        yield* paths(checkpointRef(thread, "turn-2"), checkpointRef(thread, "turn-2.end")),
      ).toEqual(["src/two.ts", "tracked.txt"]);

      yield* snapshotCheckpoint(repo, thread, "turn-3");
      write(nodePath.join(repo, "notes.md"), "running\n");
      expect(yield* paths(checkpointRef(thread, "turn-3"), "worktree")).toEqual(["notes.md"]);
    }).pipe(provide),
  );

  it.live("sees a same-size edit made in the same instant as the index it trusts for stats", () =>
    Effect.gen(function* () {
      const dir = tempDir();
      dirs.push(dir);
      const repo = makeRepo(dir);
      const file = nodePath.join(repo, "tracked.txt");
      const index = nodePath.join(repo, ".git", "index");
      // The file and the index written in the same second, ten seconds ago: git must read a file
      // that new to trust it, whatever its size and times say. ctime is left out of the stat match.
      run(repo, "config", "core.trustctime", "false");
      const then = new Date(Math.floor(Date.now() / 1000 - 10) * 1000);
      fs.utimesSync(file, then, then);
      run(repo, "add", "tracked.txt");
      fs.utimesSync(index, then, then);
      yield* snapshotCheckpoint(repo, "thread-1", "turn-1");
      fs.writeFileSync(file, "TRACKED");
      fs.utimesSync(file, then, then);
      yield* snapshotCheckpoint(repo, "thread-1", "turn-1.end");

      const diff = yield* diffBetween(
        repo,
        checkpointRef("thread-1", "turn-1"),
        checkpointRef("thread-1", "turn-1.end"),
      );
      expect(diff.files.map((f) => f.path)).toEqual(["tracked.txt"]);
    }).pipe(provide),
  );
});

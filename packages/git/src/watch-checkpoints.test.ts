import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  checkpointRef,
  diffBetween,
  isValidCheckpointId,
  listCheckpoints,
  pruneCheckpoints,
  resolveCheckpoint,
  restoreFiles,
  snapshotCheckpoint,
} from "./checkpoints.ts";
import { Proc, ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import { watchGitState, type GitStateChange, type WatchBackend } from "./watch.ts";

const provide = Effect.provide(ProcLive);

const takeWithin = <A>(queue: Queue.Queue<A>, millis: number, what: string) =>
  Queue.take(queue).pipe(
    Effect.timeoutOrElse({
      duration: millis,
      orElse: () => Effect.die(new Error(`timed out waiting for ${what}`)),
    }),
  );

describe.skipIf(!hasGit)("watch and checkpoints", () => {
  const dirs: Array<string> = [];
  const tmp = () => {
    const dir = tempDir();
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  // @parcel/watcher's Windows unsubscribe can crash the worker; see `defaultBackend`.
  const backends: ReadonlyArray<WatchBackend> =
    process.platform === "win32" ? ["node"] : ["parcel", "node"];
  for (const backend of backends)
    it.live(`emits the initial state, then again after a write and a commit (${backend})`, () =>
      Effect.gen(function* () {
        const repo = makeRepo(tmp());
        const changes = yield* Queue.unbounded<GitStateChange>();
        yield* watchGitState([repo], { debounceMs: 100, cooldownMs: 300, backend }).pipe(
          Stream.runForEach((change) => Queue.offer(changes, change)),
          Effect.forkScoped,
        );
        const initial = yield* takeWithin(changes, 15_000, "initial state");
        expect(initial.path).toBe(repo);
        expect(initial.state.changedFiles).toBe(0);

        write(nodePath.join(repo, "new.txt"), "x");
        const edited = yield* takeWithin(changes, 20_000, "working-tree edit");
        expect(edited.state.changedFiles).toBe(1);

        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "second");
        let committed = yield* takeWithin(changes, 20_000, "commit");
        while (committed.state.head === initial.state.head || committed.state.changedFiles !== 0) {
          committed = yield* takeWithin(changes, 20_000, "settled commit");
        }
        expect(committed.state.head).not.toBe(initial.state.head);
      }).pipe(Effect.scoped, provide),
    );

  it("validates checkpoint ids", () => {
    expect(isValidCheckpointId("thread-1")).toBe(true);
    expect(isValidCheckpointId("0a1b.c_d")).toBe(true);
    for (const bad of ["", ".hidden", "a..b", "x.lock", "a/b", "sp ace"])
      expect(isValidCheckpointId(bad)).toBe(false);
    expect(checkpointRef("t", "1")).toBe("refs/gram/checkpoints/t/1");
  });

  it.live("snapshots and restores files without touching the user's index", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      write(nodePath.join(repo, "other.txt"), "other\n");
      write(nodePath.join(repo, ".gitignore"), "ignored.log\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "more");
      write(nodePath.join(repo, "tracked.txt"), "staged\n");
      run(repo, "add", "tracked.txt");
      write(nodePath.join(repo, "other.txt"), "unstaged\n");
      write(nodePath.join(repo, "untracked.txt"), "new\n");
      write(nodePath.join(repo, "ignored.log"), "noise\n");

      const indexPath = nodePath.join(repo, ".git", "index");
      const indexHash = () => createHash("sha1").update(fs.readFileSync(indexPath)).digest("hex");
      const before = indexHash();
      const head = run(repo, "rev-parse", "HEAD").trim();

      const ref = yield* snapshotCheckpoint(repo, "thread-1", "turn-1");
      expect(ref).toBe("refs/gram/checkpoints/thread-1/turn-1");
      expect(indexHash()).toBe(before);
      expect(run(repo, "rev-parse", `${ref}^`).trim()).toBe(head);
      expect(run(repo, "show", `${ref}:untracked.txt`)).toBe("new\n");

      write(nodePath.join(repo, "tracked.txt"), "later\n");
      fs.rmSync(nodePath.join(repo, "untracked.txt"));
      write(nodePath.join(repo, "added-later.txt"), "later\n");
      write(nodePath.join(repo, "ignored.log"), "more noise\n");

      const diff = yield* diffBetween(repo, ref, "worktree");
      expect(diff.files.map((f) => [f.path, f.status]).toSorted()).toEqual([
        ["added-later.txt", "new"],
        ["tracked.txt", "modified"],
        ["untracked.txt", "deleted"],
      ]);

      yield* restoreFiles(repo, ref);
      expect(fs.readFileSync(nodePath.join(repo, "tracked.txt"), "utf8")).toBe("staged\n");
      expect(fs.readFileSync(nodePath.join(repo, "other.txt"), "utf8")).toBe("unstaged\n");
      expect(fs.readFileSync(nodePath.join(repo, "untracked.txt"), "utf8")).toBe("new\n");
      expect(fs.existsSync(nodePath.join(repo, "added-later.txt"))).toBe(false);
      expect(fs.readFileSync(nodePath.join(repo, "ignored.log"), "utf8")).toBe("more noise\n");
      expect(indexHash()).toBe(before);
      expect(run(repo, "diff", "--cached", "--name-only").trim()).toBe("tracked.txt");
    }).pipe(provide),
  );

  it.live("lists and prunes a thread's checkpoints and refuses bad ids", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      yield* snapshotCheckpoint(repo, "thread-1", "t1");
      write(nodePath.join(repo, "tracked.txt"), "changed\n");
      const second = yield* snapshotCheckpoint(repo, "thread-1", "t2");
      yield* snapshotCheckpoint(repo, "thread-2", "t1");
      expect(yield* listCheckpoints(repo, "thread-1")).toEqual(["t1", "t2"]);
      // A checkpoint resolves to the commit it holds; a turn without one, to nothing.
      expect(yield* resolveCheckpoint(repo, "thread-1", "t1")).toBe(
        run(repo, "rev-parse", checkpointRef("thread-1", "t1")).trim(),
      );
      expect(yield* resolveCheckpoint(repo, "thread-1", "t9")).toBeUndefined();
      const between = yield* diffBetween(repo, checkpointRef("thread-1", "t1"), second);
      expect(between.files.map((f) => f.path)).toEqual(["tracked.txt"]);
      expect(yield* pruneCheckpoints(repo, "thread-1")).toBe(2);
      expect(yield* listCheckpoints(repo, "thread-1")).toEqual([]);
      expect(yield* listCheckpoints(repo, "thread-2")).toEqual(["t1"]);
      expect((yield* Effect.flip(snapshotCheckpoint(repo, "../evil", "t"))).message).toBe(
        "invalid thread or turn id",
      );
    }).pipe(provide),
  );

  it.live("never follows a symbolic ref in the checkpoint namespace to the branch it names", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const main = run(repo, "rev-parse", "HEAD").trim();
      const branch = run(repo, "symbolic-ref", "HEAD").trim();
      // Something other than Gram (an agent, a script) points a checkpoint name at the branch.
      run(repo, "symbolic-ref", checkpointRef("thread-1", "t1"), branch);
      run(repo, "symbolic-ref", checkpointRef("thread-1", "t2"), branch);

      expect(yield* listCheckpoints(repo, "thread-1")).toEqual([]);
      expect(yield* resolveCheckpoint(repo, "thread-1", "t1")).toBeUndefined();
      expect(
        (yield* Effect.flip(restoreFiles(repo, checkpointRef("thread-1", "t1")))).message,
      ).toMatch(/is a symbolic ref, not a checkpoint/);
      expect(
        (yield* Effect.flip(diffBetween(repo, checkpointRef("thread-1", "t1"), "worktree")))
          .message,
      ).toMatch(/is a symbolic ref/);
      // A snapshot under that name replaces the symbolic ref; the branch stays where it was.
      write(nodePath.join(repo, "tracked.txt"), "turn\n");
      yield* snapshotCheckpoint(repo, "thread-1", "t2");
      expect(run(repo, "rev-parse", branch).trim()).toBe(main);
      // No longer symbolic: `symbolic-ref -q` exits non-zero.
      expect(() => run(repo, "symbolic-ref", "-q", checkpointRef("thread-1", "t2"))).toThrow();
      // Pruning removes the symbolic ref itself, never the branch.
      expect(yield* pruneCheckpoints(repo, "thread-1")).toBe(1);
      expect(run(repo, "rev-parse", "--verify", branch).trim()).toBe(main);
      expect(run(repo, "for-each-ref", "refs/").includes("checkpoints")).toBe(false);
    }).pipe(provide),
  );

  it.live("restores the commit it checked, even if the ref turns symbolic right after", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const branch = run(repo, "symbolic-ref", "HEAD").trim();
      const main = run(repo, "rev-parse", "HEAD").trim();
      write(nodePath.join(repo, "checkpoint-only.txt"), "kept\n");
      const ref = yield* snapshotCheckpoint(repo, "thread-1", "t1");
      fs.rmSync(nodePath.join(repo, "checkpoint-only.txt"));
      // Right after the guard reads the ref, something swaps it to point at the branch.
      let swapped = false;
      const racing = Layer.effect(
        Proc,
        Effect.gen(function* () {
          const live = yield* Proc;
          return {
            run: (bin, args, options) =>
              live.run(bin, args, options).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    // After the guard's own read of the ref, whichever command that is.
                    const guard = args[0] === "for-each-ref" || args[0] === "symbolic-ref";
                    if (!swapped && guard && args.at(-1) === ref) {
                      swapped = true;
                      run(repo, "symbolic-ref", ref, branch);
                    }
                  }),
                ),
              ),
          };
        }),
      ).pipe(Layer.provide(ProcLive));
      yield* restoreFiles(repo, ref).pipe(Effect.provide(racing));
      expect(swapped).toBe(true);
      // The checkpoint's files, not the branch's: its own file is back.
      expect(fs.readFileSync(nodePath.join(repo, "checkpoint-only.txt"), "utf8")).toBe("kept\n");
      expect(run(repo, "rev-parse", branch).trim()).toBe(main);
    }).pipe(provide),
  );

  it.live("refuses abbreviated checkpoint names and revision syntax", () =>
    Effect.gen(function* () {
      const repo = makeRepo(tmp());
      const branch = run(repo, "symbolic-ref", "HEAD").trim();
      run(repo, "symbolic-ref", checkpointRef("thread-1", "t1"), branch);
      const ref = yield* snapshotCheckpoint(repo, "thread-1", "t2");
      const short = checkpointRef("thread-1", "t1").replace(/^refs\//, "");
      for (const name of [
        short,
        `${checkpointRef("thread-1", "t1")}^{tree}`,
        `${ref}~0`,
        `${ref}^{tree}`,
      ]) {
        expect((yield* Effect.flip(restoreFiles(repo, name))).message, name).toMatch(
          /not a full checkpoint ref name/,
        );
        expect((yield* Effect.flip(diffBetween(repo, name, "worktree"))).message, name).toMatch(
          /not a full checkpoint ref name/,
        );
      }
    }).pipe(provide),
  );
});

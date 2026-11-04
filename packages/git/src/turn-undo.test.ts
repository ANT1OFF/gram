import * as fs from "node:fs";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { checkpointRef, snapshotCheckpoint } from "./checkpoints.ts";
import { ProcLive } from "./proc.ts";
import { hasGit, makeRepo, removeDir, run, tempDir, write } from "./test-utils.ts";
import { undoTurnFiles, type UndoHooks } from "./turn-undo.ts";

const provide = Effect.provide(ProcLive);
const THREAD = "thread-1";

describe.skipIf(!hasGit)("undoing one turn's file edits", () => {
  const dirs: Array<string> = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeDir(dir);
  });

  const setup = () => {
    const dir = tempDir();
    dirs.push(dir);
    const repo = makeRepo(dir);
    write(nodePath.join(repo, "keep.txt"), "keep\n");
    write(nodePath.join(repo, "gone.txt"), "will be deleted\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-qm", "more");
    const read = (rel: string) => {
      const path = nodePath.join(repo, rel);
      return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : undefined;
    };
    /** Runs `edit` as turn `turn`, between its start and end checkpoints. */
    const turn = (id: string, edit: () => void) =>
      Effect.gen(function* () {
        yield* snapshotCheckpoint(repo, THREAD, id);
        edit();
        yield* snapshotCheckpoint(repo, THREAD, `${id}.end`);
      });
    const undo = (id: string, hooks?: UndoHooks) =>
      undoTurnFiles(repo, checkpointRef(THREAD, id), checkpointRef(THREAD, `${id}.end`), hooks);
    /** A folder outside the repository, as a symlink's target. */
    const outside = () => {
      const path = nodePath.join(dir, "outside");
      fs.mkdirSync(path, { recursive: true });
      return path;
    };
    const exclude = (pattern: string) =>
      fs.appendFileSync(nodePath.join(repo, ".git", "info", "exclude"), `${pattern}\n`);
    /** Everything under the repository but `.git`, as `path: content`, to show nothing changed. */
    const tree = () => {
      const found: Record<string, string> = {};
      const walk = (rel: string) => {
        for (const dirent of fs.readdirSync(nodePath.join(repo, rel), { withFileTypes: true })) {
          const child = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
          if (child === ".git") continue;
          const abs = nodePath.join(repo, child);
          if (dirent.isSymbolicLink()) found[child] = `-> ${fs.readlinkSync(abs)}`;
          else if (dirent.isDirectory()) walk(child);
          else found[child] = fs.readFileSync(abs, "utf8");
        }
      };
      walk("");
      return found;
    };
    return { dir, repo, read, turn, undo, outside, exclude, tree };
  };

  it.live("reverses the turn's patch: modified, created and deleted files, and nothing else", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      // Uncommitted work from before the turn stays as it was, staged change included.
      write(nodePath.join(repo, "mine.txt"), "the user's own\n");
      write(nodePath.join(repo, "keep.txt"), "user edit before the turn\n");
      run(repo, "add", "keep.txt");
      const indexBefore = run(repo, "diff", "--cached", "--name-only");
      yield* turn("turn-1", () => {
        write(nodePath.join(repo, "tracked.txt"), "edited by the agent\n");
        write(nodePath.join(repo, "src", "new.ts"), "export {};\n");
        fs.rmSync(nodePath.join(repo, "gone.txt"));
      });
      // An unrelated edit after the turn is left alone.
      write(nodePath.join(repo, "mine.txt"), "the user's own, edited later\n");

      expect(yield* undo("turn-1")).toEqual({
        kind: "undone",
        paths: ["gone.txt", "src/new.ts", "tracked.txt"],
      });
      expect(read("tracked.txt")).toBe("tracked");
      expect(read("src/new.ts")).toBeUndefined();
      expect(read("gone.txt")).toBe("will be deleted\n");
      expect(read("keep.txt")).toBe("user edit before the turn\n");
      expect(read("mine.txt")).toBe("the user's own, edited later\n");
      expect(run(repo, "diff", "--cached", "--name-only")).toBe(indexBefore);
    }).pipe(provide),
  );

  it.live("reverses a binary file the turn changed", () =>
    Effect.gen(function* () {
      const { repo, turn, undo } = setup();
      const bin = nodePath.join(repo, "image.bin");
      fs.writeFileSync(bin, Buffer.from([0, 1, 2, 255, 254, 0, 10]));
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "binary");
      yield* turn("turn-1", () => fs.writeFileSync(bin, Buffer.from([0, 9, 9, 9, 0, 128])));

      expect((yield* undo("turn-1")).kind).toBe("undone");
      expect([...fs.readFileSync(bin)]).toEqual([0, 1, 2, 255, 254, 0, 10]);
    }).pipe(provide),
  );

  it.live("does nothing for a turn that changed no files", () =>
    Effect.gen(function* () {
      const { turn, undo } = setup();
      yield* turn("turn-1", () => {});
      expect(yield* undo("turn-1")).toEqual({ kind: "nothing" });
    }).pipe(provide),
  );

  it.live("refuses when a later turn changed the same file, touching nothing", () =>
    Effect.gen(function* () {
      const { repo, turn, undo, tree } = setup();
      yield* turn("turn-1", () => {
        write(nodePath.join(repo, "tracked.txt"), "turn 1\n");
        write(nodePath.join(repo, "other.txt"), "turn 1 too\n");
      });
      yield* turn("turn-2", () => write(nodePath.join(repo, "tracked.txt"), "turn 2\n"));
      const before = tree();

      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(tree()).toEqual(before);
    }).pipe(provide),
  );

  it.live("refuses when the user edited, deleted or recreated one of the files since", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => {
        write(nodePath.join(repo, "tracked.txt"), "turn 1\n");
        write(nodePath.join(repo, "new.txt"), "created\n");
        fs.rmSync(nodePath.join(repo, "gone.txt"));
      });

      write(nodePath.join(repo, "tracked.txt"), "the user's fix\n");
      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("the user's fix\n");
      write(nodePath.join(repo, "tracked.txt"), "turn 1\n");

      fs.rmSync(nodePath.join(repo, "new.txt"));
      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["new.txt"] });
      write(nodePath.join(repo, "new.txt"), "created\n");

      write(nodePath.join(repo, "gone.txt"), "the user put it back differently\n");
      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["gone.txt"] });
      expect(read("gone.txt")).toBe("the user put it back differently\n");
      expect(read("new.txt")).toBe("created\n");
    }).pipe(provide),
  );

  // Commits: every commit since the turn started counts, not just the net change.

  it.live("refuses when the turn's changes were committed, leaving history and files alone", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => {
        write(nodePath.join(repo, "tracked.txt"), "turn 1\n");
        run(repo, "commit", "-qam", "agent commit");
      });
      const head = run(repo, "rev-parse", "HEAD");

      expect(yield* undo("turn-1")).toEqual({ kind: "committed", paths: ["tracked.txt"] });
      expect(run(repo, "rev-parse", "HEAD")).toBe(head);
      expect(read("tracked.txt")).toBe("turn 1\n");
    }).pipe(provide),
  );

  it.live("refuses when a later commit took the turn's files", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => write(nodePath.join(repo, "new.txt"), "created\n"));
      run(repo, "add", "new.txt");
      run(repo, "commit", "-qm", "the user commits it");

      expect(yield* undo("turn-1")).toEqual({ kind: "committed", paths: ["new.txt"] });
      expect(read("new.txt")).toBe("created\n");
    }).pipe(provide),
  );

  it.live("refuses when the turn's edit was committed and then reverted", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => write(nodePath.join(repo, "tracked.txt"), "turn 1\n"));
      run(repo, "commit", "-qam", "the turn's edit");
      run(repo, "revert", "--no-edit", "HEAD");
      write(nodePath.join(repo, "tracked.txt"), "turn 1\n");

      expect(yield* undo("turn-1")).toEqual({ kind: "committed", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("turn 1\n");
    }).pipe(provide),
  );

  it.live("refuses when HEAD moved off the commit the turn started from", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => write(nodePath.join(repo, "tracked.txt"), "turn 1\n"));
      run(repo, "reset", "-q", "--soft", "HEAD~1");

      expect(yield* undo("turn-1")).toEqual({ kind: "history" });
      expect(read("tracked.txt")).toBe("turn 1\n");
    }).pipe(provide),
  );

  it.live("still undoes when commits since touched none of the turn's files", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => write(nodePath.join(repo, "tracked.txt"), "turn 1\n"));
      write(nodePath.join(repo, "keep.txt"), "committed separately\n");
      run(repo, "commit", "-qm", "unrelated", "--", "keep.txt");

      expect(yield* undo("turn-1")).toEqual({ kind: "undone", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("tracked");
      expect(read("keep.txt")).toBe("committed separately\n");
    }).pipe(provide),
  );

  // Unusual changes are refused, not handled.

  it.live("refuses a turn that changed a symlink or a file's mode", () =>
    Effect.gen(function* () {
      const { repo, turn, undo, tree } = setup();
      yield* turn("turn-1", () => fs.symlinkSync("keep.txt", nodePath.join(repo, "link")));
      expect(yield* undo("turn-1")).toEqual({
        kind: "unsupported",
        reason: "symlink",
        paths: ["link"],
      });

      yield* turn("turn-2", () => fs.chmodSync(nodePath.join(repo, "keep.txt"), 0o755));
      const before = tree();
      expect(yield* undo("turn-2")).toEqual({
        kind: "unsupported",
        reason: "mode",
        paths: ["keep.txt"],
      });
      expect(tree()).toEqual(before);
      expect(fs.statSync(nodePath.join(repo, "keep.txt")).mode & 0o100).not.toBe(0);
    }).pipe(provide),
  );

  it.live("refuses where the turn replaced a folder with a file: its parent changed type", () =>
    Effect.gen(function* () {
      const { repo, turn, undo, tree } = setup();
      write(nodePath.join(repo, "dir", "a.txt"), "a\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "dir");
      yield* turn("turn-1", () => {
        fs.rmSync(nodePath.join(repo, "dir"), { recursive: true });
        write(nodePath.join(repo, "dir"), "now a file\n");
      });
      const before = tree();

      expect(yield* undo("turn-1")).toEqual({ kind: "obstructed", paths: ["dir"] });
      expect(tree()).toEqual(before);
    }).pipe(provide),
  );

  // First review, finding 1: ignored and untracked files, and paths in the way.

  it.live("refuses when an ignored file now stands where the turn deleted one", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo, exclude } = setup();
      yield* turn("turn-1", () => run(repo, "rm", "-q", "tracked.txt"));
      exclude("tracked.txt");
      write(nodePath.join(repo, "tracked.txt"), "the user's own, ignored\n");

      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("the user's own, ignored\n");
    }).pipe(provide),
  );

  it.live("refuses where a folder now stands that a deleted file must come back to", () =>
    Effect.gen(function* () {
      const { repo, turn, undo, exclude, tree } = setup();
      yield* turn("turn-1", () => {
        fs.rmSync(nodePath.join(repo, "tracked.txt"));
        write(nodePath.join(repo, "tracked.txt", "new"), "the turn's\n");
      });
      exclude("tracked.txt/private");
      write(nodePath.join(repo, "tracked.txt", "private"), "the user's, ignored\n");
      const before = tree();

      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(tree()).toEqual(before);
    }).pipe(provide),
  );

  it.live("refuses when a symlink to elsewhere stands where a deleted file's folder was", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo, outside } = setup();
      write(nodePath.join(repo, "dir", "file"), "committed\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "dir");
      yield* turn("turn-1", () => fs.rmSync(nodePath.join(repo, "dir"), { recursive: true }));
      const elsewhere = outside();
      write(nodePath.join(elsewhere, "file"), "outside the repository\n");
      fs.symlinkSync(elsewhere, nodePath.join(repo, "dir"));

      expect(yield* undo("turn-1")).toEqual({ kind: "obstructed", paths: ["dir"] });
      expect(fs.lstatSync(nodePath.join(repo, "dir")).isSymbolicLink()).toBe(true);
      expect(read("dir/file")).toBe("outside the repository\n");
    }).pipe(provide),
  );

  it.live("never works through a folder swapped for a symlink to outside the repository", () =>
    Effect.gen(function* () {
      const { repo, turn, undo, outside } = setup();
      yield* turn("turn-1", () => write(nodePath.join(repo, "dir", "new"), "the turn's\n"));
      const elsewhere = outside();
      fs.renameSync(nodePath.join(repo, "dir"), nodePath.join(elsewhere, "moved"));
      write(nodePath.join(elsewhere, "new"), "the turn's\n");
      fs.symlinkSync(elsewhere, nodePath.join(repo, "dir"));

      expect(yield* undo("turn-1")).toEqual({ kind: "obstructed", paths: ["dir"] });
      expect(fs.readFileSync(nodePath.join(elsewhere, "new"), "utf8")).toBe("the turn's\n");
    }).pipe(provide),
  );

  // First review, finding 2: the check reads the files, never the index's word for them.

  it.live("refuses a file the index is told to assume unchanged but which was edited", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      yield* turn("turn-1", () => write(nodePath.join(repo, "tracked.txt"), "turn 1\n"));
      run(repo, "add", "tracked.txt");
      run(repo, "update-index", "--assume-unchanged", "tracked.txt");
      write(nodePath.join(repo, "tracked.txt"), "USER WORK\n");

      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("USER WORK\n");
    }).pipe(provide),
  );

  it.live("refuses a same-size edit with its old mtime under a lax stat cache", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      const file = nodePath.join(repo, "tracked.txt");
      yield* turn("turn-1", () => write(file, "turn 1\n"));
      run(repo, "config", "core.trustctime", "false");
      run(repo, "config", "core.checkStat", "minimal");
      run(repo, "add", "tracked.txt");
      const { atime, mtime } = fs.statSync(file);
      write(file, "user 1\n");
      fs.utimesSync(file, atime, mtime);

      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("user 1\n");
    }).pipe(provide),
  );

  // First review, finding 4: a folder it can't write in is refused before anything changes.

  it.live.skipIf(process.getuid?.() === 0)(
    "refuses when a folder it must write in is read-only, changing nothing",
    () =>
      Effect.gen(function* () {
        const { repo, turn, undo, tree } = setup();
        write(nodePath.join(repo, "locked", "file"), "committed\n");
        run(repo, "add", "-A");
        run(repo, "commit", "-qm", "locked");
        yield* turn("turn-1", () => {
          write(nodePath.join(repo, "added"), "the turn's\n");
          write(nodePath.join(repo, "locked", "file"), "the turn's edit\n");
        });
        const locked = nodePath.join(repo, "locked");
        const before = tree();
        fs.chmodSync(locked, 0o555);
        const result = yield* undo("turn-1").pipe(
          Effect.ensuring(Effect.sync(() => fs.chmodSync(locked, 0o755))),
        );

        expect(result).toEqual({ kind: "obstructed", paths: ["locked"] });
        expect(tree()).toEqual(before);
      }).pipe(provide),
  );

  // Second review, findings 1 and 2: a save while undo runs, and a lossy clean filter.

  it.live("lets git refuse when a save lands between the checks and the apply", () =>
    Effect.gen(function* () {
      const { repo, turn, undo, tree } = setup();
      yield* turn("turn-1", () => {
        write(nodePath.join(repo, "added"), "the turn's\n");
        write(nodePath.join(repo, "tracked.txt"), "turn 1\n");
      });
      let before: Record<string, string> = {};
      const result = yield* undo("turn-1", {
        beforeApply: () => {
          write(nodePath.join(repo, "tracked.txt"), "USER EDIT WHILE UNDOING\n");
          before = tree();
        },
      });

      expect(result.kind).toBe("refused");
      expect(tree()).toEqual(before);
      expect(before["tracked.txt"]).toBe("USER EDIT WHILE UNDOING\n");
    }).pipe(provide),
  );

  it.live("refuses a file a lossy clean filter would show as unchanged", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      write(nodePath.join(repo, ".gitattributes"), "tracked.txt filter=strip-user\n");
      run(repo, "config", "filter.strip-user.clean", "sed '/^USER:/d'");
      run(repo, "config", "filter.strip-user.smudge", "cat");
      run(repo, "add", ".gitattributes");
      run(repo, "commit", "-qm", "filter");
      yield* turn("turn-1", () => write(nodePath.join(repo, "tracked.txt"), "agent edit\n"));
      fs.appendFileSync(nodePath.join(repo, "tracked.txt"), "USER: uncommitted annotation\n");

      expect(yield* undo("turn-1")).toEqual({ kind: "changed", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("agent edit\nUSER: uncommitted annotation\n");
    }).pipe(provide),
  );

  it.live("still undoes a filtered file the user left as the turn wrote it", () =>
    Effect.gen(function* () {
      const { repo, read, turn, undo } = setup();
      // Stored with LF, written out with CRLF: the file's bytes never equal its blob.
      write(nodePath.join(repo, ".gitattributes"), "*.txt text eol=crlf\n");
      write(nodePath.join(repo, "tracked.txt"), "before\r\n");
      run(repo, "add", "-A");
      run(repo, "commit", "-qm", "crlf");
      yield* turn("turn-1", () => write(nodePath.join(repo, "tracked.txt"), "agent\r\nedit\r\n"));

      expect(yield* undo("turn-1")).toEqual({ kind: "undone", paths: ["tracked.txt"] });
      expect(read("tracked.txt")).toBe("before\r\n");
    }).pipe(provide),
  );

  it.live("refuses a checkpoint name that isn't a full ref", () =>
    Effect.gen(function* () {
      const { repo } = setup();
      const error = yield* Effect.flip(undoTurnFiles(repo, "HEAD", "HEAD~1"));
      expect(error.message).toMatch(/not a full checkpoint ref/);
    }).pipe(provide),
  );
});

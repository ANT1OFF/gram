// Undoing one turn's file edits with git's own machinery: the turn's patch (its start checkpoint
// against its end checkpoint) applied in reverse to the working tree, `git apply -R`, once every
// path it touches is checked to hold exactly what the turn left. Anything unusual is refused rather
// than handled: undo either reverses the whole patch or changes nothing.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { fail, headOid, pinCommit, repoTopOrFail, run, tempIndex } from "./checkpoint-git.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg } from "./exec.ts";

/** What `undoTurnFiles` did, or why it did nothing. Every refusal leaves the working tree as it was. */
export type TurnUndo =
  /** The turn's patch was reversed: its paths are as they were at its start. */
  | { readonly kind: "undone"; readonly paths: ReadonlyArray<string> }
  /** The turn changed no files. */
  | { readonly kind: "nothing" }
  /** A commit since the turn started changes one of these paths: undoing would leave history behind. */
  | { readonly kind: "committed"; readonly paths: ReadonlyArray<string> }
  /** HEAD is no longer on or after the commit the turn started from, so commits can't be checked. */
  | { readonly kind: "history" }
  /** These paths no longer hold exactly what the turn left: a later turn or the user changed them. */
  | { readonly kind: "changed"; readonly paths: ReadonlyArray<string> }
  /**
   * A folder above one of these paths is no longer a plain folder (a symlink, or a file), or isn't
   * writable: undo would have to work through or around it.
   */
  | { readonly kind: "obstructed"; readonly paths: ReadonlyArray<string> }
  /** The turn changed something undo doesn't handle: a symlink, a submodule, or a file's mode. */
  | {
      readonly kind: "unsupported";
      readonly reason: "symlink" | "submodule" | "mode";
      readonly paths: ReadonlyArray<string>;
    }
  /** `git apply -R --check` refused the reversed patch; nothing was changed. */
  | { readonly kind: "refused"; readonly message: string };

interface Entry {
  readonly mode: string;
  readonly oid: string;
}

/** One path the turn changed: what it held at the turn's start and at its end; absent is none. */
interface Change {
  readonly path: string;
  readonly start?: Entry;
  readonly end?: Entry;
}

const LIST_MAX = 20;

/** A side of a raw diff entry; an all-zero mode is none. */
const entry = (mode: string, oid: string): Entry | undefined =>
  /^0+$/.test(mode) ? undefined : { mode, oid };

/** `diff-tree -r -z --raw`: `:<old mode> <new mode> <old oid> <new oid> <status>\0<path>\0`. */
const parseRaw = (stdout: string): ReadonlyArray<Change> => {
  const fields = stdout.split("\0");
  const changes: Array<Change> = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    const path = fields[i + 1]!;
    if (!meta.startsWith(":") || path === "") continue;
    const [oldMode = "", newMode = "", oldOid = "", newOid = ""] = meta.slice(1).split(" ");
    const start = entry(oldMode, oldOid);
    const end = entry(newMode, newOid);
    changes.push({
      path,
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    });
  }
  return changes.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/** Output read whole, or a failure: a check never passes on a list cut at the output cap. */
const whole = (out: { readonly stdout: string; readonly truncated: boolean }, what: string) =>
  out.truncated ? fail(`${what} is too long to check`) : Effect.succeed(out.stdout);

const splitZ = (stdout: string) => stdout.split("\0").filter((path) => path !== "");

/**
 * Every path a commit since the turn started changes, whatever the net result: a change committed
 * and then reverted counts. `history` when HEAD isn't on or after the commit the turn started from.
 */
const committedPaths = (top: string, base: string | undefined, head: string | undefined) =>
  Effect.gen(function* () {
    if (head === undefined) return base === undefined ? new Set<string>() : ("history" as const);
    if (head === base) return new Set<string>();
    if (base !== undefined) {
      const ancestor = yield* git(top, ["merge-base", "--is-ancestor", base, head]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      if (ancestor.status === 1) return "history" as const;
      if (ancestor.status !== 0) return yield* fail(gitFailMsg(ancestor, "git merge-base failed"));
    }
    const out = yield* run(top, [
      "-c",
      "log.showSignature=false",
      "log",
      "-m",
      "--no-renames",
      "--name-only",
      "--format=",
      "-z",
      base === undefined ? head : `${base}..${head}`,
      "--",
    ]);
    return new Set(splitZ(yield* whole(out, "the commit history since the turn")));
  });

type FsKind = "absent" | "dir" | "file" | "symlink" | "other";

const kindOf = (abs: string): { readonly kind: FsKind; readonly stat?: fs.Stats } => {
  try {
    const stat = fs.lstatSync(abs);
    const kind: FsKind = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "dir"
        : stat.isFile()
          ? "file"
          : "other";
    return { kind, stat };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw error;
  }
};

/** The folders above `rel`, nearest the top first: `a/b/c` → `a`, `a/b`. */
const ancestorsOf = (rel: string): ReadonlyArray<string> => {
  const parts = rel.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

const blobOid = (bytes: Buffer, oidLength: number) =>
  createHash(oidLength === 64 ? "sha256" : "sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");

/** A filesystem call, its throw a `CheckpointError`. */
const sync = <A>(f: () => A) =>
  Effect.try({ try: f, catch: (e) => new CheckpointError({ message: String(e) }) });

const fileModeHonoured = (top: string) =>
  git(top, ["config", "--bool", "core.fileMode"]).pipe(
    Effect.map((out) => out.stdout.trim() !== "false"),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );

/** A private temp folder, removed when the scope closes. */
const tempFolder = Effect.acquireRelease(
  Effect.sync(() => fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-undo-"))),
  (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
);

/** For tests: runs between the checks and `git apply`, as an editor saving then would. */
export interface UndoHooks {
  readonly beforeApply?: () => void;
}

/**
 * Reverse one turn's file edits: its patch (`start` checkpoint against `end`) applied backwards to
 * the working tree with `git apply -R`, never the index. Before that every path the turn touched must
 * hold, byte for byte, what the turn left there (its end blob, or that blob as git writes it out),
 * where it deleted something nothing may stand (ignored files included), every folder above must be a
 * plain writable folder, and no commit since the turn started may touch any of them. Symlinks,
 * submodules and mode changes are refused. `git apply` checks the whole patch before it writes, so
 * the patch reverses whole or not at all.
 */
export const undoTurnFiles = (repo: string, start: string, end: string, hooks: UndoHooks = {}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const top = yield* repoTopOrFail(repo);
      const from = yield* pinCommit(top, start);
      const to = yield* pinCommit(top, end);
      const changes = parseRaw(
        yield* whole(
          yield* run(top, ["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to]),
          "the turn's changes",
        ),
      );
      if (changes.length === 0) return { kind: "nothing" } satisfies TurnUndo;
      const paths = changes.map((c) => c.path);

      // Unusual changes are refused, not handled.
      const unsupported = (
        reason: "symlink" | "submodule" | "mode",
        test: (c: Change) => boolean,
      ) => {
        const hits = changes.filter(test).map((c) => c.path);
        return hits.length === 0
          ? undefined
          : ({ kind: "unsupported", reason, paths: hits } satisfies TurnUndo);
      };
      const refusedKind =
        unsupported("submodule", (c) => c.start?.mode === "160000" || c.end?.mode === "160000") ??
        unsupported("symlink", (c) => c.start?.mode === "120000" || c.end?.mode === "120000") ??
        unsupported(
          "mode",
          (c) => c.start !== undefined && c.end !== undefined && c.start.mode !== c.end.mode,
        );
      if (refusedKind !== undefined) return refusedKind;

      // Committed: any commit since the turn started (in it or after) that touches one of its
      // paths. The start checkpoint's parent is HEAD at the turn's start.
      const base = (yield* git(top, ["rev-parse", "--verify", "--quiet", `${from}^1`]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      )).stdout.trim();
      const committed = yield* committedPaths(
        top,
        base === "" ? undefined : base,
        yield* headOid(top),
      );
      if (committed === "history") return { kind: "history" } satisfies TurnUndo;
      const hits = paths.filter((path) => committed.has(path));
      if (hits.length > 0) return { kind: "committed", paths: hits } satisfies TurnUndo;

      // The turn's end versions as git writes them out (filters and line endings applied), outside
      // the working tree, for files whose bytes differ from their stored blob.
      const scratch = yield* tempFolder;
      const endStage = nodePath.join(scratch, "end");
      const endFiles = changes.filter((c) => c.end !== undefined).map((c) => c.path);
      if (endFiles.length > 0) {
        const indexFile = yield* tempIndex;
        const env = { GIT_INDEX_FILE: indexFile };
        yield* run(top, ["read-tree", to], env);
        yield* git(
          top,
          ["checkout-index", "-f", "-z", "--stdin", `--prefix=${endStage}${nodePath.sep}`],
          { env, tier: "slow", stdin: endFiles.join("\0") },
        ).pipe(
          Effect.mapError((e) => new CheckpointError({ message: e.message })),
          Effect.flatMap((out) =>
            out.status === 0
              ? Effect.void
              : fail(gitFailMsg(out, "git couldn't write out the turn's files")),
          ),
        );
      }
      const execBits = yield* fileModeHonoured(top);

      // Every path on the filesystem itself, never through the index or a cleaned view of it.
      const verdict = yield* sync(() => {
        const changed: Array<string> = [];
        const obstructed: Array<string> = [];
        for (const change of changes) {
          // The folders above: plain folders, or absent (git creates them), nothing else.
          let nearest = top;
          let clear = true;
          for (const folder of ancestorsOf(change.path)) {
            const { kind } = kindOf(nodePath.join(top, folder));
            if (kind === "dir") {
              nearest = nodePath.join(top, folder);
              continue;
            }
            if (kind !== "absent") {
              obstructed.push(folder);
              clear = false;
            }
            break;
          }
          if (!clear) continue;
          // Git removes and writes files in the folder holding them: it must let it.
          try {
            fs.accessSync(nearest, fs.constants.W_OK);
          } catch {
            obstructed.push(nodePath.relative(top, nearest) || ".");
            continue;
          }
          const abs = nodePath.join(top, change.path);
          const { kind, stat } = kindOf(abs);
          if (change.end === undefined) {
            // The turn removed it: nothing may stand there now, ignored or not.
            if (kind !== "absent") changed.push(change.path);
            continue;
          }
          if (kind !== "file") {
            changed.push(change.path);
            continue;
          }
          if (execBits && ((stat!.mode & 0o100) !== 0) !== (change.end.mode === "100755")) {
            changed.push(change.path);
            continue;
          }
          // Byte for byte: the blob as stored, or as git writes it out. Never git's cleaned view
          // of the file, which a lossy clean filter could make match after the user added to it.
          const bytes = fs.readFileSync(abs);
          if (blobOid(bytes, change.end.oid.length) === change.end.oid) continue;
          let written: Buffer | undefined;
          try {
            written = fs.readFileSync(nodePath.join(endStage, change.path));
          } catch {
            written = undefined;
          }
          if (written === undefined || !bytes.equals(written)) changed.push(change.path);
        }
        return { changed, obstructed: [...new Set(obstructed)] };
      });
      if (verdict.obstructed.length > 0)
        return {
          kind: "obstructed",
          paths: verdict.obstructed.slice(0, LIST_MAX),
        } satisfies TurnUndo;
      if (verdict.changed.length > 0)
        return { kind: "changed", paths: verdict.changed } satisfies TurnUndo;

      // The turn's patch, written by git straight to a file (never through a string, so no byte
      // is re-encoded), whatever the user's diff config says.
      const patch = nodePath.join(scratch, "turn.patch");
      yield* run(top, [
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        `--output=${patch}`,
        from,
        to,
      ]);
      hooks.beforeApply?.();
      // Reversed into the working tree only; whitespace left exactly as the patch has it.
      const apply = ["apply", "-R", "--whitespace=nowarn"];
      const checked = yield* git(top, [...apply, "--check", patch]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      if (checked.status !== 0)
        return {
          kind: "refused",
          message: gitFailMsg(checked, "git apply refused the reversed patch"),
        } satisfies TurnUndo;
      // Never cut off halfway: an interruption waits for git to finish writing.
      const applied = yield* git(top, [...apply, patch]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
        Effect.uninterruptible,
      );
      if (applied.status !== 0)
        return {
          kind: "refused",
          message: gitFailMsg(applied, "git apply refused the reversed patch"),
        } satisfies TurnUndo;
      return { kind: "undone", paths } satisfies TurnUndo;
    }),
  );

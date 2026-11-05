// Per-turn checkpoints: the working tree (tracked + untracked, gitignore honoured) snapshotted into a
// hidden ref `refs/gram/checkpoints/<thread>/<turn>`. Every index write goes to a temporary index file
// (`GIT_INDEX_FILE`), so the user's index — staged changes included — is never touched.

import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MAX_DIFF_READ_BYTES, parseGitDiffCapped, type DiffFile } from "./diff.ts";
import { FILE_DIFF_GIT_ARGS } from "./diff-file.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg } from "./exec.ts";
import { Proc, type ProcOutput } from "./proc.ts";
import {
  fail,
  headOid,
  pinCommit,
  readRef,
  repoTopOrFail,
  run,
  tempIndex,
} from "./checkpoint-git.ts";
import { undoTurnFiles, type TurnUndo } from "./turn-undo.ts";

export const CHECKPOINT_REF_PREFIX = "refs/gram/checkpoints";

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Gram",
  GIT_AUTHOR_EMAIL: "gram@localhost",
  GIT_COMMITTER_NAME: "Gram",
  GIT_COMMITTER_EMAIL: "gram@localhost",
};

/** A thread or turn id usable as one refname component. */
export const isValidCheckpointId = (id: string): boolean =>
  /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(id) && !id.includes("..") && !id.endsWith(".lock");

export const checkpointRef = (threadId: string, turnId: string): string =>
  `${CHECKPOINT_REF_PREFIX}/${threadId}/${turnId}`;

/**
 * `for-each-ref` under `prefix`, as `[oid, refname, symbolic]`; git matches the prefix itself.
 * Gram only writes checkpoint refs holding a commit: a symbolic one (pointing at a branch, say)
 * was made by something else and is never read, moved or deleted through.
 */
const refsUnder = (top: string, prefix: string) =>
  run(top, ["for-each-ref", "--format=%(objectname) %(refname) %(symref)", `${prefix}/`]).pipe(
    Effect.map((out) =>
      out.stdout
        .split("\n")
        .map((line) => line.split(" "))
        .filter((parts) => parts.length === 3 && parts[1] !== "")
        .map(([oid, ref, symref]) => [oid!, ref!, symref !== ""] as const),
    ),
  );

/**
 * Write the current working tree as a tree object through a private index. The user's index is copied
 * first purely as a stat cache, so `add -A` doesn't rehash every file. Undo never trusts this: it
 * reads the files themselves (`turn-undo.ts`).
 */
const writeWorktreeTree = (top: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const indexFile = yield* tempIndex;
      const env = { GIT_INDEX_FILE: indexFile };
      const userIndex = (yield* run(top, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "index",
      ])).stdout.trim();
      if (fs.existsSync(userIndex)) {
        fs.copyFileSync(userIndex, indexFile);
        // The copy keeps the index's own times: git rehashes an entry written in the same second as
        // its index ("racily clean"), and a fresh copy would hide that and trust the stat match.
        const { atime, mtime } = fs.statSync(userIndex);
        fs.utimesSync(indexFile, atime, mtime);
      } else yield* run(top, ["read-tree", "--empty"], env);
      yield* run(top, ["add", "-A", "--", "."], env);
      return (yield* run(top, ["write-tree"], env)).stdout.trim();
    }),
  );

/** Snapshot the working tree into `refs/gram/checkpoints/<thread>/<turn>`; returns the ref. */
export const snapshotCheckpoint = (repo: string, threadId: string, turnId: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId) || !isValidCheckpointId(turnId)) {
      return yield* fail("invalid thread or turn id");
    }
    const top = yield* repoTopOrFail(repo);
    const tree = yield* writeWorktreeTree(top);
    const parent = yield* headOid(top);
    const commit = (yield* run(
      top,
      [
        "commit-tree",
        tree,
        ...(parent === undefined ? [] : ["-p", parent]),
        "-m",
        `checkpoint ${threadId}/${turnId}`,
      ],
      IDENTITY_ENV,
    )).stdout.trim();
    const ref = checkpointRef(threadId, turnId);
    // `--no-deref`: should the name be a symbolic ref, replace it rather than move its target.
    yield* run(top, ["update-ref", "--no-deref", ref, commit]);
    return ref;
  });

export interface CheckpointDiff {
  readonly files: ReadonlyArray<DiffFile>;
  readonly note?: string;
}

/** Diff two checkpoint refs, or a ref against the live working tree (untracked files included). */
export const diffBetween = (repo: string, from: string, to: string | "worktree") =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    const base = yield* pinCommit(top, from);
    const target = to === "worktree" ? yield* writeWorktreeTree(top) : yield* pinCommit(top, to);
    const out = yield* git(
      top,
      [
        "-c",
        "core.quotepath=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--no-color",
        base,
        target,
      ],
      { maxOutputBytes: MAX_DIFF_READ_BYTES },
    ).pipe(Effect.mapError((e) => new CheckpointError({ message: e.message })));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git diff failed"));
    const { files, note } = parseGitDiffCapped(out.stdout, out.truncated);
    return (note === undefined ? { files } : { files, note }) satisfies CheckpointDiff;
  });

/**
 * `git diff` of `paths` alone between a checkpoint and another or the live working tree (untracked
 * files included), as read up to `maxOutputBytes`; for paging through one file's patch.
 */
export const fileDiffBetween = (
  repo: string,
  from: string,
  to: string | "worktree",
  paths: ReadonlyArray<string>,
  options: { readonly ignoreWhitespace: boolean; readonly maxOutputBytes: number },
) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    const base = yield* pinCommit(top, from);
    const target = to === "worktree" ? yield* writeWorktreeTree(top) : yield* pinCommit(top, to);
    const out = yield* git(
      top,
      [
        ...FILE_DIFF_GIT_ARGS,
        "diff",
        "--no-color",
        ...(options.ignoreWhitespace ? ["-w"] : []),
        base,
        target,
        "--",
        ...paths,
      ],
      { maxOutputBytes: options.maxOutputBytes },
    ).pipe(Effect.mapError((e) => new CheckpointError({ message: e.message })));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git diff failed"));
    return out;
  });

/**
 * Put the working tree's files back to `ref`: overwrite changed files, recreate deleted ones, and delete
 * files created since. Gitignored files are left alone; the user's index is untouched.
 */
export const restoreFiles = (repo: string, wanted: string) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    const ref = yield* pinCommit(top, wanted);
    const current = yield* writeWorktreeTree(top);
    const added = (yield* run(top, [
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=A",
      "-z",
      ref,
      current,
    ])).stdout
      .split("\0")
      .filter((path) => path !== "");
    for (const rel of added) fs.rmSync(nodePath.join(top, rel), { force: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const indexFile = yield* tempIndex;
        const env = { GIT_INDEX_FILE: indexFile };
        yield* run(top, ["read-tree", ref], env);
        yield* run(top, ["checkout-index", "-a", "-f"], env);
      }),
    );
  });

/** A thread's checkpoint refs, as `[turnId, refname, symbolic]`. */
const threadRefs = (top: string, threadId: string) =>
  refsUnder(top, `${CHECKPOINT_REF_PREFIX}/${threadId}`).pipe(
    Effect.map((refs) =>
      refs.map(
        ([, ref, symbolic]) =>
          [ref.slice(`${CHECKPOINT_REF_PREFIX}/${threadId}/`.length), ref, symbolic] as const,
      ),
    ),
  );

/** Turn ids checkpointed for a thread. A symbolic ref in the namespace is no checkpoint. */
export const listCheckpoints = (repo: string, threadId: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    const top = yield* repoTopOrFail(repo);
    return (yield* threadRefs(top, threadId))
      .filter(([, , symbolic]) => !symbolic)
      .map(([turn]) => turn)
      .toSorted();
  });

/**
 * The commit a thread's checkpoint of a turn holds, or undefined. A commit, not a name: callers
 * pin it, so the name changing meanwhile can't redirect them.
 */
export const resolveCheckpoint = (repo: string, threadId: string, turnId: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId) || !isValidCheckpointId(turnId))
      return yield* fail("invalid thread or turn id");
    const top = yield* repoTopOrFail(repo);
    const read = yield* readRef(top, checkpointRef(threadId, turnId));
    return read.kind === "commit" ? read.oid : undefined;
  });

/**
 * Delete every checkpoint ref of a thread; returns how many turns. `--no-deref`: a symbolic ref
 * in the namespace is removed itself, never the branch it names.
 */
export const pruneCheckpoints = (repo: string, threadId: string) =>
  Effect.gen(function* () {
    const turns = yield* listCheckpoints(repo, threadId);
    const top = yield* repoTopOrFail(repo);
    for (const [, ref] of yield* threadRefs(top, threadId))
      yield* run(top, ["update-ref", "--no-deref", "-d", ref]);
    return turns.length;
  });

export class Checkpoints extends Context.Service<
  Checkpoints,
  {
    readonly snapshot: (
      repo: string,
      threadId: string,
      turnId: string,
    ) => Effect.Effect<string, CheckpointError>;
    readonly diffBetween: (
      repo: string,
      from: string,
      to: string | "worktree",
    ) => Effect.Effect<CheckpointDiff, CheckpointError>;
    readonly fileDiff: (
      repo: string,
      from: string,
      to: string | "worktree",
      paths: ReadonlyArray<string>,
      options: { readonly ignoreWhitespace: boolean; readonly maxOutputBytes: number },
    ) => Effect.Effect<ProcOutput, CheckpointError>;
    readonly restoreFiles: (repo: string, ref: string) => Effect.Effect<void, CheckpointError>;
    readonly undoTurn: (
      repo: string,
      start: string,
      end: string,
    ) => Effect.Effect<TurnUndo, CheckpointError>;
    readonly list: (
      repo: string,
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<string>, CheckpointError>;
    readonly prune: (repo: string, threadId: string) => Effect.Effect<number, CheckpointError>;
    readonly resolve: (
      repo: string,
      threadId: string,
      turnId: string,
    ) => Effect.Effect<string | undefined, CheckpointError>;
  }
>()("@gram/git/Checkpoints") {}

export const CheckpointsLive = Layer.effect(
  Checkpoints,
  Effect.gen(function* () {
    const proc = yield* Proc;
    const provide = Effect.provideService(Proc, proc);
    return {
      snapshot: (repo, threadId, turnId) => provide(snapshotCheckpoint(repo, threadId, turnId)),
      diffBetween: (repo, from, to) => provide(diffBetween(repo, from, to)),
      fileDiff: (repo, from, to, paths, options) =>
        provide(fileDiffBetween(repo, from, to, paths, options)),
      restoreFiles: (repo, ref) => provide(restoreFiles(repo, ref)),
      undoTurn: (repo, start, end) => provide(undoTurnFiles(repo, start, end)),
      list: (repo, threadId) => provide(listCheckpoints(repo, threadId)),
      prune: (repo, threadId) => provide(pruneCheckpoints(repo, threadId)),
      resolve: (repo, threadId, turnId) => provide(resolveCheckpoint(repo, threadId, turnId)),
    };
  }),
);

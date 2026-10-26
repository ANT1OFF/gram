// Per-turn checkpoints: the working tree (tracked + untracked, gitignore honoured) snapshotted into a
// hidden ref `refs/gram/checkpoints/<thread>/<turn>`. Every index write goes to a temporary index file
// (`GIT_INDEX_FILE`), so the user's index — staged changes included — is never touched.

import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parseGitDiffCapped, type DiffFile } from "./diff.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg, tryRepoTop } from "./exec.ts";
import { Proc } from "./proc.ts";

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

const fail = (message: string) => Effect.fail(new CheckpointError({ message }));

const run = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) =>
  git(cwd, args, { env, tier: "slow" }).pipe(
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
    Effect.flatMap((out) =>
      out.status === 0 ? Effect.succeed(out) : fail(gitFailMsg(out, `git ${args[0] ?? ""} failed`)),
    ),
  );

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

const repoTopOrFail = (repo: string) =>
  tryRepoTop(repo).pipe(
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
    Effect.flatMap((top) =>
      top === undefined ? fail(`${repo} is not a git repository`) : Effect.succeed(top),
    ),
  );

/** What one read of a ref found. */
type RefRead =
  | { readonly kind: "commit"; readonly oid: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * One read of `ref`: a full ref name (`refs/…`), whose type, commit and symbolic target one
 * exact-match `for-each-ref` reads together, or a full commit id. A symbolic ref, anything but a
 * commit, an abbreviated name and revision syntax (`^{tree}`, `~1`) are refused: Gram only ever
 * names checkpoints in full, and following a symbolic one would read the branch it points at.
 */
const readRef = (top: string, ref: string) =>
  Effect.gen(function* () {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) {
      const type = yield* git(top, ["cat-file", "-t", ref]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      return type.status === 0 && type.stdout.trim() === "commit"
        ? ({ kind: "commit", oid: ref } satisfies RefRead)
        : ({ kind: "refused", message: `${ref} is not a commit` } satisfies RefRead);
    }
    if (!ref.startsWith("refs/") || /[\s^~:?*[\\]|@\{|\.\./.test(ref))
      return {
        kind: "refused",
        message: `${ref} is not a full checkpoint ref name`,
      } satisfies RefRead;
    const out = yield* run(top, [
      "for-each-ref",
      "--format=%(objecttype) %(objectname) %(symref) %(refname)",
      ref,
    ]);
    const entry = out.stdout
      .split("\n")
      .map((line) => line.split(" "))
      .find((parts) => parts.length === 4 && parts[3] === ref);
    if (entry === undefined) return { kind: "missing" } satisfies RefRead;
    const [type, oid, symref] = entry;
    if (symref)
      return {
        kind: "refused",
        message: `${ref} is a symbolic ref, not a checkpoint`,
      } satisfies RefRead;
    if (type !== "commit")
      return {
        kind: "refused",
        message: `${ref} holds a ${type}, not a checkpoint commit`,
      } satisfies RefRead;
    return { kind: "commit", oid: oid! } satisfies RefRead;
  });

/**
 * The commit `ref` names, read once and pinned: the caller then works on that commit only and never
 * resolves the name again, so a ref swapped to a symbolic one meanwhile can't redirect it. A
 * symbolic ref, anything but a commit, abbreviated names and revision syntax are refused.
 */
const pinCommit = (top: string, ref: string) =>
  Effect.gen(function* () {
    const read = yield* readRef(top, ref);
    if (read.kind === "commit") return read.oid;
    if (read.kind === "refused") return yield* fail(read.message);
    return yield* fail(`no checkpoint ${ref}`);
  });

/** A scoped temp dir holding the private index. */
const tempIndex = Effect.acquireRelease(
  Effect.sync(() =>
    nodePath.join(fs.mkdtempSync(nodePath.join(os.tmpdir(), "gram-checkpoint-")), "index"),
  ),
  (indexFile) =>
    Effect.sync(() => fs.rmSync(nodePath.dirname(indexFile), { recursive: true, force: true })),
);

/**
 * Write the current working tree as a tree object through a private index. The user's index is copied
 * first purely as a stat cache, so `add -A` doesn't rehash every file.
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
      if (fs.existsSync(userIndex)) fs.copyFileSync(userIndex, indexFile);
      else yield* run(top, ["read-tree", "--empty"], env);
      yield* run(top, ["add", "-A", "--", "."], env);
      return (yield* run(top, ["write-tree"], env)).stdout.trim();
    }),
  );

const headOid = (top: string) =>
  git(top, ["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
    Effect.map((out) => (out.status === 0 ? out.stdout.trim() : undefined)),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
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
    const out = yield* git(top, [
      "-c",
      "core.quotepath=false",
      "-c",
      "diff.mnemonicPrefix=false",
      "diff",
      "--no-color",
      base,
      target,
    ]).pipe(Effect.mapError((e) => new CheckpointError({ message: e.message })));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git diff failed"));
    const { files, note } = parseGitDiffCapped(out.stdout, out.truncated);
    return (note === undefined ? { files } : { files, note }) satisfies CheckpointDiff;
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
    readonly restoreFiles: (repo: string, ref: string) => Effect.Effect<void, CheckpointError>;
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
      restoreFiles: (repo, ref) => provide(restoreFiles(repo, ref)),
      list: (repo, threadId) => provide(listCheckpoints(repo, threadId)),
      prune: (repo, threadId) => provide(pruneCheckpoints(repo, threadId)),
      resolve: (repo, threadId, turnId) => provide(resolveCheckpoint(repo, threadId, turnId)),
    };
  }),
);

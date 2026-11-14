// A thread's work in progress, kept off the machine it was made on: the working tree (tracked and
// untracked, gitignore honoured) committed on top of HEAD into the hidden ref
// `refs/gram/wip/<thread>` and pushed there to a remote. The branch, the user's index and the files
// are never touched, as with a turn's checkpoints. A machine that stops, or is lost, then costs
// caches, never work: the ref carries the branch's unpushed commits and what wasn't committed.
//
// On a machine that replaces it the ref is read back (`fetchWip`) and the work put where it was
// (`restoreWip`, `restoreWipWorktree`): the branch at its tip, the uncommitted files as files. The
// ref is deleted (`dropWip`) once the branch at the remote holds everything (`wipCaughtUp`), or
// with its thread.

import * as fs from "node:fs";
import * as Effect from "effect/Effect";
import { headOid, readRef, repoTopOrFail, run } from "./checkpoint-git.ts";
import { IDENTITY_ENV, isValidCheckpointId, writeWorktreeTree } from "./checkpoints.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg, STRICT_STATUS_ARGS } from "./exec.ts";
import { samePath } from "./paths.ts";

export const WIP_REF_PREFIX = "refs/gram/wip";

export const wipRef = (threadId: string): string => `${WIP_REF_PREFIX}/${threadId}`;

/** A push can carry many objects over a slow link. */
const PUSH_TIMEOUT_MS = 120_000;

const fail = (message: string) => Effect.fail(new CheckpointError({ message }));

export interface WipSnapshot {
  readonly ref: string;
  /** The commit the ref now names: HEAD itself when nothing is uncommitted. */
  readonly commit: string;
  /** Whether the working tree held anything HEAD doesn't. */
  readonly uncommitted: boolean;
}

/**
 * Points `refs/gram/wip/<thread>` at the working tree as it is: HEAD when nothing is uncommitted,
 * otherwise a commit of the tree on top of HEAD. A tree already kept under the ref on the same
 * HEAD keeps its commit, so a repeat pushes nothing new.
 */
export const snapshotWip = (repo: string, threadId: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId);
    const tree = yield* writeWorktreeTree(top);
    const head = yield* headOid(top);
    const treeOf = (commit: string) =>
      run(top, ["rev-parse", "--verify", `${commit}^{tree}`]).pipe(
        Effect.map((out) => out.stdout.trim()),
      );
    const uncommitted = head === undefined || (yield* treeOf(head)) !== tree;
    let commit = head;
    if (uncommitted || commit === undefined) {
      const kept = yield* readRef(top, ref);
      const parents =
        kept.kind === "commit"
          ? (yield* run(top, ["rev-list", "--parents", "-n", "1", kept.oid])).stdout
              .trim()
              .split(" ")
              .slice(1)
          : undefined;
      const same =
        kept.kind === "commit" &&
        (yield* treeOf(kept.oid)) === tree &&
        (head === undefined ? parents?.length === 0 : parents?.length === 1 && parents[0] === head);
      commit =
        same && kept.kind === "commit"
          ? kept.oid
          : (yield* run(
              top,
              [
                "commit-tree",
                tree,
                ...(head === undefined ? [] : ["-p", head]),
                "-m",
                `work in progress ${threadId}`,
              ],
              IDENTITY_ENV,
            )).stdout.trim();
    }
    // `--no-deref`: should the name be a symbolic ref, replace it rather than move its target.
    yield* run(top, ["update-ref", "--no-deref", ref, commit]);
    return { ref, commit, uncommitted } satisfies WipSnapshot;
  });

/** A remote as `git push` takes it: a remote's name or a URL, never something read as an option. */
export const isPushRemote = (remote: string): boolean =>
  remote !== "" && !remote.startsWith("-") && !/[\s\0]/.test(remote);

/** The transports a push may use, as a clone on a host may: never a helper, a file or `git://`. */
export const WIP_PUSH_PROTOCOLS = "https:ssh";

/** The thread a work-in-progress ref is for, when `ref` is one this module wrote. */
const threadOfWipRef = (ref: string): string | undefined => {
  const prefix = `${WIP_REF_PREFIX}/`;
  const id = ref.slice(0, prefix.length) === prefix ? ref.slice(prefix.length) : "";
  return isValidCheckpointId(id) ? id : undefined;
};

/**
 * Pushes `commit` to `remote` as the thread's work-in-progress ref, replacing what the remote kept
 * under it: the ref is this thread's own and is rewritten at each snapshot. Only that ref is
 * written, whatever the user's config says of tags, submodules and signing; no pre-push hook runs,
 * since nothing a person reviews is published, and credentials are never prompted for. Only over
 * `protocols` (`GIT_ALLOW_PROTOCOL`), so a remote can't name a helper to run.
 */
export const pushWip = (
  repo: string,
  snapshot: WipSnapshot,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
) =>
  Effect.gen(function* () {
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    if (
      threadOfWipRef(snapshot.ref) === undefined ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(snapshot.commit)
    )
      return yield* fail("not a work-in-progress snapshot");
    const top = yield* repoTopOrFail(repo);
    const out = yield* git(
      top,
      [
        "push",
        "--force",
        "--no-verify",
        "--no-follow-tags",
        "--no-signed",
        "--recurse-submodules=no",
        "--",
        remote,
        `${snapshot.commit}:${snapshot.ref}`,
      ],
      {
        timeoutMs: PUSH_TIMEOUT_MS,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: protocols },
      },
    ).pipe(Effect.mapError((e) => new CheckpointError({ message: e.message })));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git push failed"));
  });

/** What a remote kept of a thread's work, once fetched into a repository here. */
export interface WipKept {
  readonly ref: string;
  /** The commit the ref names. */
  readonly commit: string;
  /** The branch's tip when the work was kept; absent when the repository had no commit yet. */
  readonly head: string | undefined;
  /** Whether `commit` holds files beyond `head`: the working tree as it was. */
  readonly uncommitted: boolean;
}

/** Never a hook of the repository's, nor a prompt: nothing a person is there to answer. */
const QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "credential.interactive=false"];

const network = (protocols: string) => ({
  timeoutMs: PUSH_TIMEOUT_MS,
  env: { GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: protocols },
});

const networkGit = (top: string, args: ReadonlyArray<string>, protocols: string) =>
  git(top, args, network(protocols)).pipe(
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );

/** The commit `remote` has under `ref`, a full ref name; `undefined` when it has none. */
const remoteRef = (top: string, remote: string, ref: string, protocols: string) =>
  Effect.gen(function* () {
    const out = yield* networkGit(top, ["ls-remote", "--", remote, ref], protocols);
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git ls-remote failed"));
    for (const line of out.stdout.split("\n")) {
      const [oid, name] = line.trim().split(/\s+/);
      if (name === ref && oid !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
        return oid;
    }
    return undefined;
  });

/**
 * Fetches what `remote` kept of the thread into the repository at `repo`, under the same hidden
 * ref, and says what it holds; `undefined` when the remote kept nothing. Only that ref is fetched:
 * no tags, no submodules, and only over `protocols`. A commit this module made on top of the
 * branch (`snapshotWip`'s, by its message, its committer and its single parent) holds uncommitted
 * files; any other is the branch's own tip, kept as it was.
 */
export const fetchWip = (
  repo: string,
  threadId: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId);
    if ((yield* remoteRef(top, remote, ref, protocols)) === undefined) return undefined;
    const fetched = yield* networkGit(
      top,
      [
        ...QUIET,
        "fetch",
        "--quiet",
        "--no-tags",
        "--recurse-submodules=no",
        "--no-write-fetch-head",
        "--",
        remote,
        `+${ref}:${ref}`,
      ],
      protocols,
    );
    if (fetched.status !== 0) return yield* fail(gitFailMsg(fetched, "git fetch failed"));
    const kept = yield* readRef(top, ref);
    if (kept.kind !== "commit")
      return yield* fail(kept.kind === "refused" ? kept.message : `${ref} didn't arrive`);
    const [committer, parents, subject] = (yield* run(top, [
      "log",
      "-1",
      "--format=%ce%x00%P%x00%s",
      kept.oid,
    ])).stdout
      .replace(/\n$/, "")
      .split("\0");
    const above = (parents ?? "").split(" ").filter((parent) => parent !== "");
    const made =
      committer === IDENTITY_ENV.GIT_COMMITTER_EMAIL &&
      subject === `work in progress ${threadId}` &&
      above.length <= 1;
    return {
      ref,
      commit: kept.oid,
      head: made ? above[0] : kept.oid,
      uncommitted: made,
    } satisfies WipKept;
  });

/**
 * Puts kept work back in the working tree at `repo`, which must hold nothing of its own (a fresh
 * clone, a worktree just added): `branch` is set to the tip the work was on and checked out (a
 * detached HEAD there without one), and the files that weren't committed are written as files,
 * uncommitted again. What was staged comes back unstaged. Refused, with nothing changed, over a
 * working tree that has changes.
 */
export const restoreWip = (repo: string, kept: WipKept, branch?: string) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    if (kept.head === undefined)
      return yield* fail("the work was kept before the repository had a commit");
    if (branch !== undefined) {
      const named = yield* git(top, ["check-ref-format", "--branch", branch]).pipe(
        Effect.mapError((e) => new CheckpointError({ message: e.message })),
      );
      if (named.status !== 0 || branch.startsWith("-")) return yield* fail("invalid branch");
    }
    if (branch !== undefined) {
      // Never a branch another worktree is on: moving it would change that worktree under it.
      const listed = (yield* run(top, ["worktree", "list", "--porcelain", "-z"])).stdout.split(
        "\0\0",
      );
      for (const entry of listed) {
        const fields = entry.split("\0");
        const at = fields.find((field) => field.startsWith("worktree "))?.slice(9);
        if (at === undefined || !fields.includes(`branch refs/heads/${branch}`)) continue;
        if (!samePath(at, top)) return yield* fail(`${branch} is checked out in ${at}`);
      }
    }
    const status = yield* run(top, [...STRICT_STATUS_ARGS]);
    if (status.stdout.trim() !== "")
      return yield* fail(`${top} has changes of its own, so nothing was put back over them`);
    yield* run(top, [
      ...QUIET,
      "checkout",
      "--quiet",
      ...(branch === undefined ? ["--detach"] : ["-B", branch]),
      kept.head,
      "--",
    ]);
    if (!kept.uncommitted) return;
    // The files as they were, then the index back at the branch: uncommitted, as they were.
    yield* run(top, [...QUIET, "read-tree", "--reset", "-u", kept.commit]);
    yield* run(top, [...QUIET, "reset", "--quiet", kept.head, "--"]);
  });

/**
 * A worktree of the repository at `repo` made at `dir`, which must not exist, with the kept work
 * put back in it (`restoreWip`). One that can't be finished is removed again, so a folder is
 * there only with the work in it.
 */
export const restoreWipWorktree = (repo: string, dir: string, kept: WipKept, branch?: string) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    if (kept.head === undefined)
      return yield* fail("the work was kept before the repository had a commit");
    if (dir.startsWith("-") || fs.existsSync(dir)) return yield* fail(`${dir} is there already`);
    // A folder that is gone is still registered until pruned, and git refuses to add over it.
    yield* run(top, ["worktree", "prune"]);
    yield* run(top, [...QUIET, "worktree", "add", "--quiet", "--detach", dir, kept.head]);
    yield* restoreWip(dir, kept, branch).pipe(
      Effect.onError(() =>
        git(top, ["worktree", "remove", "--force", dir]).pipe(
          Effect.ignore,
          Effect.andThen(Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true }))),
          Effect.andThen(git(top, ["worktree", "prune"]).pipe(Effect.ignore)),
        ),
      ),
    );
  });

/**
 * Whether the branch at `remote` holds everything `snapshot` does: nothing is uncommitted, HEAD is
 * on a branch, and the remote's branch of that name is at the same commit, asked of the remote
 * itself rather than read from a remote-tracking ref that may be stale.
 */
export const wipCaughtUp = (
  repo: string,
  snapshot: WipSnapshot,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
) =>
  Effect.gen(function* () {
    if (snapshot.uncommitted || !isPushRemote(remote)) return false;
    const top = yield* repoTopOrFail(repo);
    const branch = yield* git(top, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
      Effect.mapError((e) => new CheckpointError({ message: e.message })),
    );
    const name = branch.stdout.trim();
    if (branch.status !== 0 || !name.startsWith("refs/heads/")) return false;
    return (yield* remoteRef(top, remote, name, protocols)) === snapshot.commit;
  });

/**
 * Deletes the thread's work-in-progress ref at `remote` and here: its branch holds the work now,
 * or the thread is closed. A remote that has no such ref is as wanted. Only that ref is deleted.
 */
export const dropWip = (
  repo: string,
  threadId: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId);
    if ((yield* remoteRef(top, remote, ref, protocols)) !== undefined) {
      const out = yield* networkGit(
        top,
        [
          "push",
          "--no-verify",
          "--no-follow-tags",
          "--no-signed",
          "--recurse-submodules=no",
          "--",
          remote,
          `:${ref}`,
        ],
        protocols,
      );
      if (out.status !== 0) return yield* fail(gitFailMsg(out, "git push failed"));
    }
    yield* run(top, ["update-ref", "--no-deref", "-d", ref]);
  });

/** Whether the repository at `repo` holds the thread's work-in-progress ref: read here, no remote asked. */
export const hasWip = (repo: string, threadId: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return false;
    const top = yield* repoTopOrFail(repo);
    return (yield* readRef(top, wipRef(threadId))).kind === "commit";
  });

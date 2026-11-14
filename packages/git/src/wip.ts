// A thread's work in progress, kept off the machine it was made on: the working tree (tracked and
// untracked, gitignore honoured) committed on top of HEAD into the hidden ref
// `refs/gram/wip/<thread>` and pushed there to a remote. The branch, the user's index and the files
// are never touched, as with a turn's checkpoints. A machine that stops, or is lost, then costs
// caches, never work: the ref carries the branch's unpushed commits and what wasn't committed.
//
// On a machine that replaces it the ref is read back (`fetchWip`) and the work put where it was
// (`restoreWip`, `restoreWipWorktree`): the branch at its tip, the uncommitted files as files. The
// ref is deleted (`dropWip`) once the branch at the remote holds everything (`wipCaughtUp`), and
// then only when deleting it loses nothing: the ref is one per thread at the remote, and another
// folder of the thread, here or on another machine, may have written it since. A thread whose
// branch held everything gets its folder back from that branch (`fetchBranchTip`).

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
  /**
   * The commit the ref named in this repository before, when it named another: what this
   * repository last kept or put back of the thread, which the working tree has moved on from.
   */
  readonly previous?: string;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `ancestor` is `commit` or one of its ancestors; false when either isn't here. */
const isAncestor = (top: string, ancestor: string, commit: string) =>
  git(top, ["merge-base", "--is-ancestor", ancestor, commit]).pipe(
    Effect.map((out) => out.status === 0),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );

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
    const kept = yield* readRef(top, ref);
    if (uncommitted || commit === undefined) {
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
    return {
      ref,
      commit,
      uncommitted,
      ...(kept.kind === "commit" && kept.oid !== commit ? { previous: kept.oid } : {}),
    } satisfies WipSnapshot;
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
    if (threadOfWipRef(snapshot.ref) === undefined || !OID.test(snapshot.commit))
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
      if (name === ref && oid !== undefined && OID.test(oid)) return oid;
    }
    return undefined;
  });

/**
 * Fetches what `remote` kept of the thread into the repository at `repo`, under the same hidden
 * ref, and says what it holds; `undefined` when the remote kept nothing. Only that ref is fetched:
 * no tags, no submodules, and only over `protocols`. A commit this module made on top of the
 * branch (`snapshotWip`'s, by its message, its committer and its single parent) holds uncommitted
 * files; any other is the branch's own tip, kept as it was.
 *
 * Whoever can push to the remote can write the ref. Given `expected`, the commit a stop said it
 * kept, the remote's ref must name exactly that commit: any other is refused, before anything of
 * it is fetched.
 */
export const fetchWip = (
  repo: string,
  threadId: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
  expected?: string,
) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    if (expected !== undefined && !OID.test(expected)) return yield* fail("invalid commit");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId);
    const theirs = yield* remoteRef(top, remote, ref, protocols);
    if (theirs === undefined) return undefined;
    const unexpected = `${ref} at the remote isn't the commit the stop kept, so nothing of it was put back`;
    if (expected !== undefined && theirs !== expected) return yield* fail(unexpected);
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
    if (expected !== undefined && kept.oid !== expected) {
      // Rewritten between the look and the fetch: not kept here either.
      yield* run(top, ["update-ref", "--no-deref", "-d", ref]);
      return yield* fail(unexpected);
    }
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

/** A branch name as `git checkout` takes one, never something read as an option. */
const isBranchName = (top: string, branch: string) =>
  git(top, ["check-ref-format", "--branch", branch]).pipe(
    Effect.map((named) => named.status === 0 && !branch.startsWith("-")),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );

/**
 * Fetches the tip of `branch` at `remote` into the repository at `repo` and says what it is, as
 * work kept with nothing uncommitted; `undefined` when the remote has no such branch. For a thread
 * whose branch at the remote held everything, so that no ref was kept of it. Only that branch is
 * fetched: no tags, no submodules, and only over `protocols`. No local branch is made or moved.
 */
export const fetchBranchTip = (
  repo: string,
  branch: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
) =>
  Effect.gen(function* () {
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    const top = yield* repoTopOrFail(repo);
    if (!(yield* isBranchName(top, branch))) return yield* fail("invalid branch");
    const ref = `refs/heads/${branch}`;
    const tip = yield* remoteRef(top, remote, ref, protocols);
    if (tip === undefined) return undefined;
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
        ref,
      ],
      protocols,
    );
    if (fetched.status !== 0) return yield* fail(gitFailMsg(fetched, "git fetch failed"));
    // The branch may have moved between the look and the fetch: the tip seen must have arrived.
    if ((yield* readRef(top, tip)).kind !== "commit") return yield* fail(`${ref} didn't arrive`);
    return { ref, commit: tip, head: tip, uncommitted: false } satisfies WipKept;
  });

export interface WipRestored {
  /**
   * `branch` was here already with commits made after the work was kept, and nothing was
   * uncommitted in what was kept: the branch is checked out as it is here, which holds it all.
   */
  readonly ahead: boolean;
}

export interface RestoreOptions {
  /**
   * A working tree of the same repository that gives `branch` up when it is on it with no changes
   * of its own: its HEAD is detached where it is, so nothing in it changes. For the clone a host
   * keeps to make worktrees from, which a fresh clone leaves on the default branch.
   */
  readonly release?: string;
}

/**
 * Puts kept work back in the working tree at `repo`, which must hold nothing of its own (a fresh
 * clone, a worktree just added): `branch` is set to the tip the work was on and checked out (a
 * detached HEAD there without one), and the files that weren't committed are written as files,
 * uncommitted again. What was staged comes back unstaged. Refused, with nothing changed, over a
 * working tree that has changes.
 *
 * A `branch` that is here already is only ever moved forward: one behind the kept tip, or at it,
 * is set to it. One with commits the kept work doesn't hold is never moved. When it holds all of
 * the kept work (nothing was uncommitted) it is checked out as it is; otherwise nothing is put
 * back and nothing is changed, since no place for the kept files loses nothing.
 */
export const restoreWip = (
  repo: string,
  kept: WipKept,
  branch?: string,
  options: RestoreOptions = {},
) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    const head = kept.head;
    if (head === undefined)
      return yield* fail("the work was kept before the repository had a commit");
    if (branch !== undefined && !(yield* isBranchName(top, branch)))
      return yield* fail("invalid branch");
    let release: string | undefined;
    if (branch !== undefined) {
      // Never a branch another worktree is on: moving it would change that worktree under it.
      const listed = (yield* run(top, ["worktree", "list", "--porcelain", "-z"])).stdout.split(
        "\0\0",
      );
      for (const entry of listed) {
        const fields = entry.split("\0");
        const at = fields.find((field) => field.startsWith("worktree "))?.slice(9);
        if (at === undefined || !fields.includes(`branch refs/heads/${branch}`)) continue;
        if (samePath(at, top)) continue;
        const gives =
          options.release !== undefined &&
          samePath(at, options.release) &&
          (yield* run(at, [...STRICT_STATUS_ARGS])).stdout.trim() === "";
        if (!gives) return yield* fail(`${branch} is checked out in ${at}`);
        release = at;
      }
    }
    const status = yield* run(top, [...STRICT_STATUS_ARGS]);
    if (status.stdout.trim() !== "")
      return yield* fail(`${top} has changes of its own, so nothing was put back over them`);
    let ahead = false;
    if (branch !== undefined) {
      const here = yield* readRef(top, `refs/heads/${branch}`);
      if (here.kind === "refused") return yield* fail(here.message);
      if (
        here.kind === "commit" &&
        here.oid !== head &&
        !(yield* isAncestor(top, here.oid, head))
      ) {
        ahead = !kept.uncommitted && (yield* isAncestor(top, head, here.oid));
        if (!ahead)
          return yield* fail(
            `${branch} is here already with commits the kept work doesn't hold, so it was not moved and nothing was put back`,
          );
      }
    }
    if (release !== undefined)
      yield* run(release, [...QUIET, "checkout", "--quiet", "--detach", "HEAD", "--"]);
    yield* run(top, [
      ...QUIET,
      "checkout",
      "--quiet",
      ...(branch === undefined ? ["--detach", head] : ahead ? [branch] : ["-B", branch, head]),
      "--",
    ]);
    if (kept.uncommitted) {
      // The files as they were, then the index back at the branch: uncommitted, as they were.
      yield* run(top, [...QUIET, "read-tree", "--reset", "-u", kept.commit]);
      yield* run(top, [...QUIET, "reset", "--quiet", head, "--"]);
    }
    return { ahead } satisfies WipRestored;
  });

/** Whether nothing is at `dir`, or only an empty folder. */
const isFree = (dir: string): boolean => {
  try {
    return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
};

/**
 * A worktree of the repository at `repo` made at `dir`, where nothing is yet but perhaps an empty
 * folder, with the kept work put back in it (`restoreWip`). One that can't be finished is removed
 * again, so a folder is there only with the work in it. The repository's own working tree gives
 * `branch` up when it is on it with no changes (`RestoreOptions.release`).
 */
export const restoreWipWorktree = (repo: string, dir: string, kept: WipKept, branch?: string) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    if (kept.head === undefined)
      return yield* fail("the work was kept before the repository had a commit");
    if (dir.startsWith("-") || !isFree(dir)) return yield* fail(`${dir} is there already`);
    // A folder that is gone is still registered until pruned, and git refuses to add over it.
    yield* run(top, ["worktree", "prune"]);
    yield* run(top, [...QUIET, "worktree", "add", "--quiet", "--detach", dir, kept.head]);
    return yield* restoreWip(dir, kept, branch, { release: top }).pipe(
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

/** What `dropWip` found of the ref at the remote: deleted, never there, or left as it is. */
export type WipDropped = "dropped" | "absent" | "left";

/** What holds a thread's work now, so that its ref may go. */
export interface WipHeld {
  /** A commit known to be safe at the remote: its branch's tip there. */
  readonly by: string;
  /** Commits this repository kept of the thread before, which its working tree moved on from. */
  readonly also?: ReadonlyArray<string>;
}

/**
 * Deletes the thread's work-in-progress ref at `remote` and here. A remote that has no such ref is
 * as wanted. Only that ref is deleted, and only while it still names the commit it was seen at.
 *
 * The ref is one per thread at the remote, so another folder of the thread (another clone here,
 * another machine) may have written it. Given `held`, the remote's ref goes only when deleting it
 * loses nothing: it names `held.by`, one of `held.also`, or a commit here that `held.by` contains.
 * Anything else is `left`: it may be work only that ref holds. Without `held` it is deleted
 * whatever it names: for a thread that is gone for good.
 */
export const dropWip = (
  repo: string,
  threadId: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
  held?: WipHeld,
) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId);
    const theirs = yield* remoteRef(top, remote, ref, protocols);
    let dropped: WipDropped = "absent";
    if (theirs !== undefined) {
      const safe =
        held === undefined ||
        theirs === held.by ||
        (held.also ?? []).includes(theirs) ||
        (yield* isAncestor(top, theirs, held.by));
      if (safe) {
        const out = yield* networkGit(
          top,
          [
            "push",
            "--no-verify",
            "--no-follow-tags",
            "--no-signed",
            "--recurse-submodules=no",
            // Only the commit just looked at: one written since is somebody's work.
            `--force-with-lease=${ref}:${theirs}`,
            "--",
            remote,
            `:${ref}`,
          ],
          protocols,
        );
        if (out.status !== 0) return yield* fail(gitFailMsg(out, "git push failed"));
        dropped = "dropped";
      } else dropped = "left";
    }
    yield* run(top, ["update-ref", "--no-deref", "-d", ref]);
    return dropped;
  });

/** Whether the repository at `repo` holds the thread's work-in-progress ref: read here, no remote asked. */
export const hasWip = (repo: string, threadId: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return false;
    const top = yield* repoTopOrFail(repo);
    return (yield* readRef(top, wipRef(threadId))).kind === "commit";
  });

// A thread's work in progress, kept off the machine it was made on: the working tree (tracked and
// untracked, gitignore honoured) committed on top of HEAD into a hidden ref and pushed there to a
// remote. Each folder of a thread has its own ref, `refs/gram/wip/<thread>--<folder>`
// (`wipRef`), so two checkouts of one repository (its clone and a linked worktree, say) are each
// kept, and each put back from its own; `refs/gram/wip/<thread>` is the thread's one ref from
// before, still read back, and still what a thread moved to another server is bundled under. The branch, the user's index and the files
// are never touched, as with a turn's checkpoints. A machine that stops, or is lost, then costs
// caches, never work: the ref carries the branch's unpushed commits and what wasn't committed.
//
// On a machine that replaces it the ref is read back (`fetchWip`) and the work put where it was
// (`restoreWip`, `restoreWipWorktree`): the branch at its tip, the uncommitted files as files. The
// ref is deleted (`dropWip`) once the branch at the remote holds everything (`wipCaughtUp`), and
// then only when deleting it loses nothing: another machine may have written it since. A thread whose
// branch held everything gets its folder back from that branch (`fetchBranchTip`).
//
// A push replaces the remote's ref only while it names what this repository last kept or put back
// of the thread there (its lease, `refs/gram/wip-lease/…`, local and never pushed), or nothing
// when it never had any: a fresh clone, a folder a resume skipped, or one written to before its
// work came back can't replace the only copy of work it didn't come from.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { devNull } from "node:os";
import * as Effect from "effect/Effect";
import { headOid, readRef, repoTopOrFail, run } from "./checkpoint-git.ts";
import { IDENTITY_ENV, isValidCheckpointId, writeWorktreeTree } from "./checkpoints.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg, STRICT_STATUS_ARGS } from "./exec.ts";
import { samePath } from "./paths.ts";
import { MAX_DIFF_READ_BYTES, parseGitDiffCapped, type DiffFile, withinViewCap } from "./diff.ts";
import { localBaseRef } from "./refs.ts";

export const WIP_REF_PREFIX = "refs/gram/wip";

/**
 * The host's own name under `refs/gram/wip`, when it has one: `GRAM_HOST_WIP_NAMESPACE`. A host
 * whose remote lets each machine write only refs under its own name (a hosted sandbox behind a
 * git proxy, say) keeps its threads' work at `refs/gram/wip/<namespace>/<thread>`, and reads it
 * back from there. Unset, or not a plain name, the ref is `refs/gram/wip/<thread>`.
 */
export const WIP_NAMESPACE_ENV = "GRAM_HOST_WIP_NAMESPACE";
/** A plain name: one path segment git takes as a ref component, so never `.` or `..`. */
const NAMESPACE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const hostNamespace = (): string | undefined => {
  const value = process.env[WIP_NAMESPACE_ENV];
  return value !== undefined && NAMESPACE.test(value) ? value : undefined;
};

/** How a folder's ref names it: a hash of its path as Gram names the folder, never the path. */
const FOLDER_KEY = /--[0-9a-f]{16}$/;
const folderKey = (folder: string) =>
  createHash("sha256").update(folder).digest("hex").slice(0, 16);

/**
 * Where this host keeps the thread's work of `folder`, its path as Gram names it:
 * `refs/gram/wip/<thread>--<folder>`, under the host's namespace when it has one. Without
 * `folder`, the thread's one ref from before each folder had its own: `refs/gram/wip/<thread>`.
 */
export const wipRef = (threadId: string, folder?: string): string => {
  const namespace = hostNamespace();
  const name = folder === undefined ? threadId : `${threadId}--${folderKey(folder)}`;
  return namespace === undefined
    ? `${WIP_REF_PREFIX}/${name}`
    : `${WIP_REF_PREFIX}/${namespace}/${name}`;
};

/** `ref`'s last part without a folder's key: what names the thread. */
const withoutFolder = (ref: string) => ref.replace(FOLDER_KEY, "");

/**
 * Whether `ref` is where a host keeps `threadId`'s work, of one folder or the thread's one ref from
 * before: with no namespace, or under one.
 */
export const isWipRefOf = (ref: string, threadId: string): boolean => {
  const bare = withoutFolder(ref);
  if (bare === `${WIP_REF_PREFIX}/${threadId}`) return true;
  const start = `${WIP_REF_PREFIX}/`;
  const end = `/${threadId}`;
  if (!bare.startsWith(start) || !bare.endsWith(end)) return false;
  return NAMESPACE.test(bare.slice(start.length, bare.length - end.length));
};

/** Whether `ref` is this host's own ref of the thread, a folder's or the thread's from before. */
const isOwnWipRef = (ref: string, threadId: string) =>
  ref === wipRef(threadId) || (FOLDER_KEY.test(ref) && withoutFolder(ref) === wipRef(threadId));

/**
 * Where a repository notes the commit the remote held under `ref` when it last kept or put back
 * the thread's work: what its next push is held to (`--force-with-lease`). Local, never pushed.
 */
const leaseRef = (ref: string) => `refs/gram/wip-lease/${ref.slice(WIP_REF_PREFIX.length + 1)}`;
/** Notes a ref fetched here whose work wasn't put back yet: the folder didn't come from it. */
const fetchedRef = (ref: string) => `refs/gram/wip-fetched/${ref.slice(WIP_REF_PREFIX.length + 1)}`;

/** Why a push left the remote's ref as it was: it holds work this folder didn't come from. */
export const WIP_LEASE_REFUSED =
  "The thread's work saved at the remote didn't come from this folder, so it wasn't replaced: this folder's work is kept here only.";

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
  /**
   * The commit the remote's ref must name for the push to replace it: what this repository last
   * kept or put back there. Absent: the remote must have no such ref.
   */
  readonly lease?: string;
}

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether `ancestor` is `commit` or one of its ancestors; false when either isn't here. */
const isAncestor = (top: string, ancestor: string, commit: string) =>
  git(top, ["merge-base", "--is-ancestor", ancestor, commit]).pipe(
    Effect.map((out) => out.status === 0),
    Effect.mapError((e) => new CheckpointError({ message: e.message })),
  );

/**
 * What this repository's next push of `ref` is held to: its lease; none while a ref fetched here
 * waits to be put back. A repository from before leases has the ref it kept itself instead
 * (`kept`, what `ref` named here before the snapshot).
 */
const leaseOf = (top: string, ref: string, kept: string | undefined) =>
  Effect.gen(function* () {
    const lease = yield* readRef(top, leaseRef(ref));
    if (lease.kind === "commit") return lease.oid;
    if ((yield* readRef(top, fetchedRef(ref))).kind === "commit") return undefined;
    return kept;
  });

/**
 * Points the thread's ref of `folder` (`wipRef`) at the working tree as it is: HEAD when nothing is
 * uncommitted, otherwise a commit of the tree on top of HEAD. A tree already kept under the ref on
 * the same HEAD keeps its commit, so a repeat pushes nothing new. Without `folder`, the thread's
 * one ref (`refs/gram/wip/<thread>`), as a thread moved to another server is bundled under.
 */
export const snapshotWip = (repo: string, threadId: string, folder?: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId, folder);
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
    const lease = yield* leaseOf(top, ref, kept.kind === "commit" ? kept.oid : undefined);
    // `--no-deref`: should the name be a symbolic ref, replace it rather than move its target.
    yield* run(top, ["update-ref", "--no-deref", ref, commit]);
    return {
      ref,
      commit,
      uncommitted,
      ...(kept.kind === "commit" && kept.oid !== commit ? { previous: kept.oid } : {}),
      ...(lease === undefined ? {} : { lease }),
    } satisfies WipSnapshot;
  });

/** A remote as `git push` takes it: a remote's name or a URL, never something read as an option. */
export const isPushRemote = (remote: string): boolean =>
  remote !== "" && !remote.startsWith("-") && !/[\s\0]/.test(remote);

/** The transports a push may use, as a clone on a host may: never a helper, a file or `git://`. */
export const WIP_PUSH_PROTOCOLS = "https:ssh";

/**
 * The thread a work-in-progress ref is for, when `ref` is one this module wrote:
 * `refs/gram/wip/<thread>`, or `refs/gram/wip/<namespace>/<thread>` under a host's namespace, each
 * maybe with a folder's key (`--<folder>`).
 */
const threadOfWipRef = (ref: string): string | undefined => {
  const prefix = `${WIP_REF_PREFIX}/`;
  if (ref.slice(0, prefix.length) !== prefix) return undefined;
  const rest = withoutFolder(ref).slice(prefix.length).split("/");
  const id = rest.at(-1) ?? "";
  if (rest.length > 2 || !isValidCheckpointId(id)) return undefined;
  return rest.length === 1 || isWipRefOf(ref, id) ? id : undefined;
};

/**
 * Pushes `commit` to `remote` as the thread's work-in-progress ref, replacing what the remote kept
 * under it only while that is the snapshot's lease (`WipSnapshot.lease`), or nothing with none.
 * A remote holding other work is left as it is, and the push fails with `WIP_LEASE_REFUSED`;
 * unless the remote has no such ref any more, or one the commit holds, which is replaced, since
 * that loses nothing. A push that took becomes the repository's lease. Only that ref is
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
    if (snapshot.lease !== undefined && !OID.test(snapshot.lease))
      return yield* fail("not a work-in-progress snapshot");
    const top = yield* repoTopOrFail(repo);
    const push = (lease: string | undefined) =>
      networkGit(
        top,
        [
          "push",
          "--no-verify",
          "--no-follow-tags",
          "--no-signed",
          "--recurse-submodules=no",
          // Never `--force`, which would override the lease.
          `--force-with-lease=${snapshot.ref}:${lease ?? ""}`,
          "--",
          remote,
          `${snapshot.commit}:${snapshot.ref}`,
        ],
        protocols,
      );
    let out = yield* push(snapshot.lease);
    if (out.status !== 0 && /\(stale info\)/.test(`${out.stdout}\n${out.stderr}`)) {
      // The remote's ref isn't what this repository last saw there.
      const theirs = yield* remoteRef(top, remote, snapshot.ref, protocols);
      if (theirs === undefined) out = yield* push(undefined);
      else if (theirs !== snapshot.commit && !(yield* isAncestor(top, theirs, snapshot.commit)))
        return yield* fail(WIP_LEASE_REFUSED);
      else out = yield* push(theirs);
    }
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git push failed"));
    yield* run(top, ["update-ref", "--no-deref", leaseRef(snapshot.ref), snapshot.commit]);
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
const QUIET = ["-c", `core.hooksPath=${devNull}`, "-c", "credential.interactive=false"];

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
 *
 * `from` reads the thread's work from another host's ref of it (`refs/gram/wip/<name>/<thread>`),
 * as one written on another Gram's machine is when the thread moved here, or from this host's ref
 * of it from before each folder had its own; it must be a ref of that thread (`isWipRefOf`).
 * Unset, the ref is this host's own of `folder` (`wipRef`).
 */
export const fetchWip = (
  repo: string,
  threadId: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
  expected?: string,
  from?: string,
  folder?: string,
) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    if (expected !== undefined && !OID.test(expected)) return yield* fail("invalid commit");
    if (from !== undefined && !isWipRefOf(from, threadId)) return yield* fail("invalid ref");
    const top = yield* repoTopOrFail(repo);
    const ref = from ?? wipRef(threadId, folder);
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
    // Not this folder's lease until its work is put back (`restoreWip`).
    if (isOwnWipRef(ref, threadId))
      yield* run(top, ["update-ref", "--no-deref", fetchedRef(ref), kept.oid]);
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
  expected?: string,
) =>
  Effect.gen(function* () {
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    if (expected !== undefined && !OID.test(expected)) return yield* fail("invalid commit");
    const top = yield* repoTopOrFail(repo);
    if (!(yield* isBranchName(top, branch))) return yield* fail("invalid branch");
    const ref = `refs/heads/${branch}`;
    const tip = yield* remoteRef(top, remote, ref, protocols);
    if (tip === undefined) return undefined;
    // Given the commit the branch was seen at, the remote's branch must still name it.
    if (expected !== undefined && tip !== expected)
      return yield* fail(`${ref} at the remote is not the commit that was kept`);
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
 * Fails over a sparse checkout, which writes only the paths its patterns take in: kept files
 * outside them would be left out, and the folder taken as back without them. Asked before anything
 * is changed, by every step of putting work back.
 */
const refuseSparse = (top: string) =>
  Effect.gen(function* () {
    const sparse = yield* git(top, ["config", "--type=bool", "--get", "core.sparseCheckout"]).pipe(
      Effect.map((out) => out.status === 0 && out.stdout.trim() === "true"),
      Effect.mapError((e) => new CheckpointError({ message: e.message })),
    );
    if (sparse)
      return yield* fail(
        `${top} is a sparse checkout, so not every kept file would be written: nothing was put back`,
      );
  });

/**
 * Puts kept work back in the working tree at `repo`, which must hold nothing of its own (a fresh
 * clone, a worktree just added): `branch` is set to the tip the work was on and checked out (a
 * detached HEAD there without one), and the files that weren't committed are written as files,
 * uncommitted again. What was staged comes back unstaged. Refused, with nothing changed, over a
 * working tree that has changes.
 *
 * A `branch` that is here already is only ever moved forward: one behind the kept tip, or at it,
 * is set to it. One with commits the kept work doesn't hold is moved only when a remote's branch
 * holds every one of them (a fresh clone whose default branch moved on since the work was kept):
 * it is set back to the kept tip, and those commits stay on the remote. Otherwise it is never
 * moved: when it holds all of the kept work (nothing was uncommitted) it is checked out as it is,
 * and else nothing is put back and nothing is changed, since no place for the kept files loses
 * nothing.
 */
/** Whether every commit `tip` has that `base` doesn't is on a remote's branch here too. */
const onlyRemoteCommits = (top: string, tip: string, base: string) =>
  run(top, ["rev-list", "--count", tip, "--not", base, "--remotes"]).pipe(
    Effect.map((out) => out.stdout.trim() === "0"),
  );

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
    yield* refuseSparse(top);
    // The end of every restore: the index back at HEAD, the kept files staying as files, and the
    // remote's ref, when it came from this host's own ref of the thread, the folder's lease. Over
    // a folder that already holds the work (`again`), only what a restore cut off left undone:
    // the index only while it is exactly the kept files a restore wrote there, never what was
    // staged since, and a lease only where the folder has none, never one it moved on to.
    const finish = (at: string, again: boolean) =>
      Effect.gen(function* () {
        const index = again
          ? yield* git(top, ["write-tree"]).pipe(
              Effect.map((out) => (out.status === 0 ? out.stdout.trim() : undefined)),
              Effect.mapError((e) => new CheckpointError({ message: e.message })),
            )
          : undefined;
        const left =
          !again ||
          (index !== undefined &&
            index ===
              (yield* run(top, [
                "rev-parse",
                "--verify",
                "--quiet",
                `${kept.commit}^{tree}`,
              ])).stdout.trim());
        if (kept.uncommitted && left) yield* run(top, [...QUIET, "reset", "--quiet", at, "--"]);
        const thread = threadOfWipRef(kept.ref);
        if (thread !== undefined && isOwnWipRef(kept.ref, thread)) {
          if (!again || (yield* readRef(top, leaseRef(kept.ref))).kind !== "commit")
            yield* run(top, ["update-ref", "--no-deref", leaseRef(kept.ref), kept.commit]);
          yield* run(top, ["update-ref", "--no-deref", "-d", fetchedRef(kept.ref)]);
        }
      });
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
    // Already holding the kept uncommitted work, as a restore before this one left it, its answer
    // lost or its host gone part way: done, rather than refused below for changes that are the
    // work itself, once what such a restore may not have reached is done too (`finish`). HEAD at
    // the branch's tip as kept, or past it, on that branch, and the files exactly as the work was
    // kept. A clean tree goes the usual way, which puts the same back.
    const current = kept.uncommitted ? yield* headOid(top) : undefined;
    const on =
      current === undefined
        ? false
        : branch === undefined ||
          (yield* git(top, ["symbolic-ref", "--quiet", "HEAD"]).pipe(
            Effect.map((out) => out.status === 0 && out.stdout.trim() === `refs/heads/${branch}`),
            Effect.orElseSucceed(() => false),
          ));
    if (
      on &&
      current !== undefined &&
      (current === head || (yield* isAncestor(top, head, current))) &&
      (yield* writeWorktreeTree(top)) ===
        (yield* run(top, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${kept.commit}^{tree}`,
        ])).stdout.trim()
    ) {
      yield* finish(current, true);
      return { ahead: current !== head } satisfies WipRestored;
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
        if (!ahead && !(yield* onlyRemoteCommits(top, here.oid, head)))
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
    // The files as they were, then the index back at the branch: uncommitted, as they were.
    if (kept.uncommitted) yield* run(top, [...QUIET, "read-tree", "--reset", "-u", kept.commit]);
    yield* finish(head, false);
    return { ahead } satisfies WipRestored;
  });

/**
 * Clears the working tree at `repo` for `restoreWip` to put `kept` back over, losing nothing: what
 * it holds that HEAD doesn't (gitignore honoured), and commits on `branch` the kept work doesn't
 * hold, go on the new branch `aside` first, and HEAD is left detached at it. Ignored files stay as
 * they are. A working tree exactly as `left` holds it (the work as it was when it left, which the
 * kept work carried on from) has nothing of its own. Answers `aside` when anything went on it, and
 * nothing when the folder held nothing of its own.
 */
export const setAsideFor = (
  repo: string,
  kept: WipKept,
  branch: string | undefined,
  aside: string,
  left?: string,
) =>
  Effect.gen(function* () {
    const top = yield* repoTopOrFail(repo);
    if (kept.head === undefined)
      return yield* fail("the work was kept before the repository had a commit");
    if (!(yield* isBranchName(top, aside))) return yield* fail("invalid branch");
    if (branch !== undefined && !(yield* isBranchName(top, branch)))
      return yield* fail("invalid branch");
    if (left !== undefined && !OID.test(left)) return yield* fail("invalid commit");
    // Refused here, where `restoreWip` would refuse it after this had moved HEAD and the branch.
    yield* refuseSparse(top);
    const head = yield* headOid(top);
    const tree = yield* writeWorktreeTree(top);
    const treeOf = (commit: string) =>
      run(top, ["rev-parse", "--verify", "--quiet", `${commit}^{tree}`]).pipe(
        Effect.map((out) => out.stdout.trim()),
      );
    const dirty = head === undefined || (yield* treeOf(head)) !== tree;
    const asLeft = dirty && left !== undefined && (yield* treeOf(left)) === tree;
    const own = dirty && !asLeft;
    // A branch here the kept work doesn't contain, and that doesn't contain all of it either.
    const tip = branch === undefined ? undefined : yield* readRef(top, `refs/heads/${branch}`);
    if (tip?.kind === "refused") return yield* fail(tip.message);
    const diverged =
      tip?.kind === "commit" &&
      tip.oid !== kept.head &&
      !(yield* isAncestor(top, tip.oid, kept.head)) &&
      (kept.uncommitted || !(yield* isAncestor(top, kept.head, tip.oid)));
    // Commits made on a detached HEAD that the kept work doesn't hold and no branch or tag does:
    // reachable from nothing else once the folder moves on.
    const stray =
      head !== undefined &&
      head !== kept.head &&
      !(yield* isAncestor(top, head, kept.head)) &&
      (yield* run(top, [
        "for-each-ref",
        "--contains",
        head,
        "refs/heads",
        "refs/tags",
      ])).stdout.trim() === "";
    if (!dirty && !diverged && !stray) return undefined;
    if (diverged && tip?.kind === "commit" && head !== tip.oid)
      return yield* fail(`${branch} has commits of its own in another folder`);
    // Never a branch another folder is on: moving it would change that folder under it.
    if (diverged && branch !== undefined) {
      const listed = (yield* run(top, ["worktree", "list", "--porcelain", "-z"])).stdout.split(
        "\0\0",
      );
      for (const entry of listed) {
        const fields = entry.split("\0");
        const at = fields.find((field) => field.startsWith("worktree "))?.slice(9);
        if (
          at !== undefined &&
          !samePath(at, top) &&
          fields.includes(`branch refs/heads/${branch}`)
        )
          return yield* fail(`${branch} is checked out in ${at}`);
      }
    }
    const putAside = own || diverged || stray;
    if (putAside && (yield* readRef(top, `refs/heads/${aside}`)).kind !== "missing")
      return yield* fail(`${aside} is a branch here already`);
    const at = own
      ? (yield* run(
          top,
          [
            "commit-tree",
            tree,
            ...(head === undefined ? [] : ["-p", head]),
            "-m",
            "Put aside before a thread's work came back",
          ],
          IDENTITY_ENV,
        )).stdout.trim()
      : asLeft
        ? left!
        : head!;
    if (putAside) yield* run(top, ["update-ref", `refs/heads/${aside}`, own ? at : head!, ""]);
    // HEAD at a commit of the files as they are: nothing in the folder changes yet.
    yield* run(top, ["update-ref", "--no-deref", "HEAD", at]);
    yield* run(top, [...QUIET, "read-tree", "--reset", at]);
    if (diverged && tip?.kind === "commit")
      yield* run(top, ["update-ref", `refs/heads/${branch}`, kept.head, tip.oid]);
    return putAside ? aside : undefined;
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
 * Deletes the thread's work-in-progress ref of `folder` (`wipRef`) at `remote` and here. A remote
 * that has no such ref is as wanted. Only that ref is deleted, and only while it still names the
 * commit it was seen at.
 *
 * Another machine (or, for the thread's one ref from before, another folder of the thread) may
 * have written it. Given `held`, the remote's ref goes only when deleting it loses nothing: it
 * names `held.by`, one of `held.also`, or a commit here that `held.by` contains. Anything else is
 * `left`: it may be work only that ref holds. Without `held` it is deleted whatever it names: for
 * a thread that is gone for good.
 */
export const dropWip = (
  repo: string,
  threadId: string,
  remote = "origin",
  protocols: string = WIP_PUSH_PROTOCOLS,
  held?: WipHeld,
  folder?: string,
) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return yield* fail("invalid thread id");
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    const top = yield* repoTopOrFail(repo);
    const ref = wipRef(threadId, folder);
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
    // The remote has no such ref now: the next push is held to that. One left there stays the
    // lease it was, which holds other work.
    if (dropped !== "left") {
      yield* run(top, ["update-ref", "--no-deref", "-d", leaseRef(ref)]);
      yield* run(top, ["update-ref", "--no-deref", "-d", fetchedRef(ref)]);
    }
    return dropped;
  });

/**
 * Whether the repository at `repo` holds the thread's work-in-progress ref of `folder`, or its one
 * ref from before without: read here, no remote asked.
 */
export const hasWip = (repo: string, threadId: string, folder?: string) =>
  Effect.gen(function* () {
    if (!isValidCheckpointId(threadId)) return false;
    const top = yield* repoTopOrFail(repo);
    return (yield* readRef(top, wipRef(threadId, folder))).kind === "commit";
  });

/** What a kept commit holds against the branch's base (`wipChanges`). */
export interface WipChanges {
  /** The ref the files are against; absent when there is none, and only HEAD's are against HEAD. */
  readonly base?: string;
  readonly files: ReadonlyArray<DiffFile>;
  /** Set when the diff was too large to list, or bodies were dropped to fit `maxBytes`. */
  readonly note?: string;
}

/**
 * The files `snapshot`'s commit changes against where its branch left its base (`base...commit`),
 * so what a save holds can be shown while its machine is away: the branch's commits and what wasn't
 * committed alike. With no base to go by, against HEAD, which is the uncommitted alone. Bodies
 * past `maxBytes` are dropped, the largest first, and those files noted `too large`.
 */
export const wipChanges = (repo: string, snapshot: Pick<WipSnapshot, "commit">, maxBytes: number) =>
  Effect.gen(function* () {
    if (!OID.test(snapshot.commit)) return yield* fail("invalid commit");
    const top = yield* repoTopOrFail(repo);
    const base = yield* localBaseRef(top);
    const head = yield* headOid(top);
    const range =
      base !== undefined
        ? [`${base}...${snapshot.commit}`]
        : head === undefined
          ? undefined
          : [head, snapshot.commit];
    if (range === undefined) return { files: [] } satisfies WipChanges;
    const out = yield* git(
      top,
      [
        "-c",
        "core.quotepath=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        ...range,
        "--",
      ],
      { maxOutputBytes: MAX_DIFF_READ_BYTES },
    ).pipe(Effect.mapError((e) => new CheckpointError({ message: e.message })));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git diff failed"));
    const capped = parseGitDiffCapped(out.stdout, out.truncated);
    const files = withinViewCap(capped.files, maxBytes);
    const cut = files.some(
      (file, at) => file.note === "too large" && capped.files[at]?.note !== "too large",
    );
    const note =
      capped.note ?? (cut ? "The largest files are listed without their changes." : undefined);
    return {
      ...(base === undefined ? {} : { base }),
      files,
      ...(note === undefined ? {} : { note }),
    } satisfies WipChanges;
  });

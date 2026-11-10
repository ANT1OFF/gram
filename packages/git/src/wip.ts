// A thread's work in progress, kept off the machine it was made on: the working tree (tracked and
// untracked, gitignore honoured) committed on top of HEAD into the hidden ref
// `refs/gram/wip/<thread>` and pushed there to a remote. The branch, the user's index and the files
// are never touched, as with a turn's checkpoints. A machine that stops, or is lost, then costs
// caches, never work: the ref carries the branch's unpushed commits and what wasn't committed.

import * as Effect from "effect/Effect";
import { headOid, readRef, repoTopOrFail, run } from "./checkpoint-git.ts";
import { IDENTITY_ENV, isValidCheckpointId, writeWorktreeTree } from "./checkpoints.ts";
import { CheckpointError } from "./errors.ts";
import { git, gitFailMsg } from "./exec.ts";

export const WIP_REF_PREFIX = "refs/gram/wip";

/** A ref this module wrote: the prefix and one thread id, nothing below or beside it. */
const WIP_REF = /^refs\/gram\/wip\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

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

/**
 * Pushes `commit` to `remote` as the thread's work-in-progress ref, replacing what the remote kept
 * under it: the ref is this thread's own and is rewritten at each snapshot. Never prompts for
 * credentials, and runs no pre-push hook, since nothing a person reviews is published.
 */
export const pushWip = (repo: string, snapshot: WipSnapshot, remote = "origin") =>
  Effect.gen(function* () {
    if (!isPushRemote(remote)) return yield* fail("invalid remote");
    if (!WIP_REF.test(snapshot.ref) || !/^[0-9a-f]{40,64}$/.test(snapshot.commit))
      return yield* fail("not a work-in-progress snapshot");
    const top = yield* repoTopOrFail(repo);
    const out = yield* git(
      top,
      ["push", "--force", "--no-verify", "--", remote, `${snapshot.commit}:${snapshot.ref}`],
      { timeoutMs: PUSH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: "0" } },
    ).pipe(Effect.mapError((e) => new CheckpointError({ message: e.message })));
    if (out.status !== 0) return yield* fail(gitFailMsg(out, "git push failed"));
  });

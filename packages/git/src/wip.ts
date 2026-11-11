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

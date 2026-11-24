import {
  type Checkout,
  effectiveCheckout,
  type HostId,
  hostOf,
  hostServes,
  LOCAL_HOST_ID,
  type Thread,
} from "@gram/contracts";
import { folderName, randomWorktreeName } from "@gram/git";
import * as Effect from "effect/Effect";
import * as nodePath from "node:path";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { cloneUrlOf } from "../host/repos.ts";
import { keepThreadWork } from "../host/stop-resume.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";

/**
 * Moves a worker between two joined machines, between its turns (docs/EMBEDDING.md, "Moving a
 * worker"). Nothing of a turn can be carried: its processes, its terminals and the agent's own
 * session file stay behind. So the worker is moved at rest, by what a machine's stop already uses:
 * its folders are kept at the remote on its hidden ref (`host.stop.keep`), the machine it goes to
 * makes them again from the remote and that ref (`host.stop.restore`), and only then is the thread
 * pointed there. Its next session opens on the new machine and reads the recent turns, as after a
 * machine came back on another disk. A step that fails leaves the worker where it was. The folder
 * it leaves is removed only if nothing in it is uncommitted; otherwise it stays until its machine
 * goes, and its work is at the remote either way. The folders it was let read on the old machine
 * (`readAlso`) are not on the new one, and are let go.
 */

/** Why a worker wasn't moved. `busy`: it is in a turn, and can be moved once it rests. */
export class WorkerNotMoved extends Error {
  readonly busy: boolean;
  constructor(message: string, busy = false) {
    super(message);
    this.busy = busy;
  }
}

export interface WorkerMoveDeps {
  readonly hosts: Pick<RemoteHostsShape, "connection" | "machines" | "stops">;
  readonly runtimes: Pick<ThreadRuntimesShape, "relocate" | "updateThread">;
}

const refuse = (message: string, busy = false) => Effect.fail(new WorkerNotMoved(message, busy));

const cut = (text: string) => text.slice(0, 300);

const foldersOn = (thread: Thread, from: HostId): ReadonlyArray<Checkout> =>
  [thread.checkout, ...(thread.extraCheckouts ?? [])].filter(
    (checkout) => hostOf(checkout) === from,
  );

/**
 * Moves `thread` to the joined machine `to`. `moved: false` when it is there already. Refused,
 * with the worker left as it is, when it is in a turn (`busy`), runs on this machine or follows a
 * worktree of its own making, when a folder of it wasn't made from a clone a host keeps, when its
 * work couldn't be kept at the remote, or when the machine it goes to can't put a folder back.
 */
export const moveWorkerTo = (
  deps: WorkerMoveDeps,
  thread: Thread,
  to: { readonly id: HostId; readonly name: string },
): Effect.Effect<{ readonly moved: boolean; readonly thread: Thread }, WorkerNotMoved> =>
  Effect.gen(function* () {
    const from = hostOf(effectiveCheckout(thread));
    if (from === to.id) return { moved: false, thread };
    if (from === LOCAL_HOST_ID || thread.checkout.hostId === undefined)
      return yield* refuse(
        `${thread.title} runs on this machine, in a folder no joined machine keeps, so it can't be moved to one. Stop it and spawn its work again there.`,
      );
    if (thread.currentCheckout !== undefined)
      return yield* refuse(
        `${thread.title} works in a worktree it made itself, which a move would leave behind.`,
      );
    const folders = foldersOn(thread, thread.checkout.hostId);
    const sources = folders.map((checkout) => ({
      checkout,
      url: checkout.cloneIdentity === undefined ? undefined : cloneUrlOf(checkout.cloneIdentity),
    }));
    if (
      sources.some((each) => each.url === undefined) ||
      folders.length !== 1 + (thread.extraCheckouts ?? []).length
    )
      return yield* refuse(
        `${thread.title} has a folder that wasn't made from a clone its machine keeps, so its work can't be carried to another.`,
      );
    const target = yield* deps.hosts
      .connection(to.id)
      .pipe(
        Effect.mapError(() => new WorkerNotMoved(`${to.name} isn't online, so nothing was moved.`)),
      );
    const restore = target.stop.restore;
    if (restore === undefined || !hostServes(target.hello, "wip-restore-ref"))
      return yield* refuse(
        `${to.name} runs an older Gram host that can't take a moved worker's folders. Update it, or spawn the work again there.`,
      );
    const made: Array<{ readonly repoPath: string; readonly cwd: string }> = [];
    const undo = Effect.forEach(
      made,
      ({ repoPath, cwd }) =>
        target.worktrees
          .remove({ repoPath, worktreeDir: cwd, force: true, openCheckouts: [] })
          .pipe(Effect.timeout("2 minutes"), Effect.ignore),
      { discard: true },
    );
    const prepare = Effect.gen(function* () {
      const kept = yield* keepThreadWork({ hosts: deps.hosts }, from as HostId, thread).pipe(
        Effect.mapError(
          (error) => new WorkerNotMoved(`Its work couldn't be kept: ${cut(error.message)}`),
        ),
      );
      const placed: Checkout[] = [];
      for (const { checkout, url } of sources) {
        const work = kept.find((each) => each.cwd === checkout.path);
        if (work === undefined || !work.pushed || work.commit === undefined)
          return yield* refuse(
            `Its work in ${checkout.path} couldn't be kept at the remote${work?.note === undefined ? "" : ` (${cut(work.note)})`}, so nothing was moved.`,
          );
        const branch = work.branch ?? checkout.branch;
        const { path: repoPath } = yield* target.repos.ensure(url!).pipe(
          Effect.mapError(
            (error) =>
              new WorkerNotMoved(`${to.name} couldn't clone its repository: ${cut(error.message)}`),
          ),
          Effect.timeoutOrElse({
            duration: "10 minutes",
            orElse: () => refuse(`${to.name} took too long to clone its repository.`),
          }),
        );
        const join =
          repoPath.includes("\\") && !repoPath.includes("/")
            ? nodePath.win32.join
            : nodePath.posix.join;
        const restoreAt = (cwd: string) =>
          restore({
            threadId: thread.id,
            cwd,
            url: url!,
            ...(branch === undefined ? {} : { branch }),
            commit: work.commit!,
            ...(work.caughtUp === true || work.ref === undefined
              ? { caughtUp: true }
              : { ref: work.ref }),
          }).pipe(
            Effect.mapError(
              (error) =>
                new WorkerNotMoved(
                  `${to.name} couldn't put its folder back: ${cut(error.message)}`,
                ),
            ),
          );
        let cwd = join(repoPath, ".worktrees", folderName(branch ?? randomWorktreeName()));
        let answer = yield* restoreAt(cwd);
        if (!answer.restored && answer.there === true) {
          cwd = join(repoPath, ".worktrees", randomWorktreeName());
          answer = yield* restoreAt(cwd);
        }
        if (answer.restored) made.push({ repoPath, cwd });
        if (!answer.restored || answer.commit !== work.commit)
          return yield* refuse(
            `${to.name} couldn't put its folder back${answer.note === undefined ? "" : `: ${cut(answer.note)}`}, so nothing was moved.`,
          );
        placed.push({
          ...checkout,
          path: cwd,
          hostId: to.id,
          ...(checkout.repoRoot === undefined ? {} : { repoRoot: repoPath }),
        });
      }
      return placed;
    }).pipe(Effect.tapError(() => undo));
    let placed: ReadonlyArray<Checkout> = [];
    const first = Effect.map(prepare, (all) => {
      placed = all;
      return all[0]!;
    });
    const moved = yield* deps.runtimes
      .relocate(thread.id, { from: thread.checkout, prepare: first })
      .pipe(
        Effect.tapError((error) => (error instanceof WorkerNotMoved ? Effect.void : undo)),
        Effect.mapError((error) =>
          error instanceof WorkerNotMoved
            ? error
            : new WorkerNotMoved(
                error._tag === "ThreadNotFound"
                  ? `${thread.title} is gone.`
                  : `${thread.title} wasn't moved: ${error.message}. It moves once it is at rest.`,
                error._tag === "InvalidState" && error.message === "the thread is at work",
              ),
        ),
      );
    const extras = placed.slice(1);
    const settled = yield* deps.runtimes
      .updateThread(thread.id, (current) => {
        const { extraCheckouts: _extras, additionalDirectories: _dirs, ...rest } = current;
        return {
          ...rest,
          ...(extras.length === 0
            ? {}
            : {
                extraCheckouts: extras,
                additionalDirectories: extras.map((extra) => extra.path),
              }),
        };
      })
      .pipe(Effect.orElseSucceed(() => moved));
    const source = yield* deps.hosts.connection(from as HostId).pipe(Effect.option);
    if (source._tag === "Some")
      yield* Effect.forEach(
        folders,
        (checkout) =>
          checkout.repoRoot === undefined
            ? Effect.void
            : source.value.worktrees
                .remove({
                  repoPath: checkout.repoRoot,
                  worktreeDir: checkout.path,
                  force: false,
                  openCheckouts: [],
                })
                .pipe(Effect.timeout("2 minutes"), Effect.ignore),
        { discard: true },
      );
    return { moved: true, thread: settled };
  });

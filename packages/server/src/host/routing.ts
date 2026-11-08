import type { GitState, HostHello } from "@gram/contracts";
import { type GitStateRuntime, samePathKey, type Worktrees } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { HostFiles } from "./files.ts";
import type { HostConnection } from "./protocol.ts";
import type { PortScan } from "../ports/scan.ts";

/** The parts of this machine that can run in the host process, as the server reaches them. */
export interface MachineParts {
  readonly files: HostFiles;
  readonly worktrees: Worktrees["Service"];
  readonly git: GitStateRuntime["Service"];
  readonly scan: Effect.Effect<PortScan, unknown>;
  readonly hello?: HostHello;
}

/**
 * This machine's folders, worktrees, local git state and port scan through the host process
 * `host`, each falling back to `inServer`: a host that has gone hands its work back to the server
 * from then on, rather than failing it, and a watch it was serving restarts in the server.
 *
 * The network tier of a git snapshot (the PR badge, the fetch behind the rebase signal) stays in
 * the server, built on the host's local read.
 */
export const throughHost = (host: HostConnection, inServer: MachineParts): MachineParts => {
  const either =
    <Args extends ReadonlyArray<unknown>, A, E>(
      viaHost: (...args: Args) => Effect.Effect<A, E>,
      local: (...args: Args) => Effect.Effect<A, E>,
    ) =>
    (...args: Args): Effect.Effect<A, E> =>
      // Chosen when the call runs, so an effect built before the host went still falls back.
      Effect.suspend(() => (host.gone() ? local(...args) : viaHost(...args)));
  /**
   * Like `either`, for a read that is safe to ask twice: one in flight when the host goes is asked
   * again in the server rather than failed. A change (create, remove, restore) is never retried,
   * since the host may have made it before it went.
   */
  const read =
    <Args extends ReadonlyArray<unknown>, A, E>(
      viaHost: (...args: Args) => Effect.Effect<A, E>,
      local: (...args: Args) => Effect.Effect<A, E>,
    ) =>
    (...args: Args): Effect.Effect<A, E> =>
      Effect.suspend(() =>
        host.gone()
          ? local(...args)
          : viaHost(...args).pipe(
              Effect.catch((error) => (host.gone() ? local(...args) : Effect.fail(error))),
            ),
      );

  /**
   * The host's latest local read of each checkout, by `samePathKey`, from a read or its watcher:
   * what a snapshot that `reuseLocal`s builds on, as the server's own runtime keeps for itself.
   */
  const lastLocal = new Map<string, GitState>();
  const remember = (cwd: string, state: GitState) =>
    Effect.sync(() => {
      lastLocal.set(samePathKey(cwd), state);
    });
  const localRead = (cwd: string) =>
    host.git.local(cwd).pipe(Effect.tap((state) => remember(cwd, state)));
  const git: GitStateRuntime["Service"] = {
    local: read(localRead, inServer.git.local),
    // The host answers "there" when it can't say; one that went meanwhile is asked again here.
    present: (cwd) =>
      Effect.suspend(() =>
        host.gone()
          ? inServer.git.present(cwd)
          : host.git
              .present(cwd)
              .pipe(
                Effect.flatMap((there) =>
                  host.gone() ? inServer.git.present(cwd) : Effect.succeed(there),
                ),
              ),
      ),
    snapshot: (cwd, options) =>
      Effect.suspend(() => {
        if (host.gone()) return inServer.git.snapshot(cwd, options);
        const kept =
          options.local ??
          (options.reuseLocal === true ? lastLocal.get(samePathKey(cwd)) : undefined);
        return Effect.flatMap(kept === undefined ? localRead(cwd) : Effect.succeed(kept), (local) =>
          inServer.git.snapshot(cwd, { ...options, local }),
        );
      }),
    watch: (paths, options) =>
      Stream.suspend(() =>
        host.gone()
          ? inServer.git.watch(paths, options)
          : host.git.watch(paths, options).pipe(
              Stream.tap((change) => remember(change.path, change.state)),
              Stream.catch(() => inServer.git.watch(paths, options)),
            ),
      ),
  };

  const parts: MachineParts = {
    files: {
      list: read(host.files.list, inServer.files.list),
      search: read(host.files.search, inServer.files.search),
      names: read(host.files.names, inServer.files.names),
    },
    worktrees: {
      // An activity lookup is a function the host can't be sent; such a list runs here.
      list: (repoPath, options) =>
        Effect.suspend(() =>
          host.gone() || options.lastActivity !== undefined
            ? inServer.worktrees.list(repoPath, options)
            : host.worktrees
                .list(repoPath, { openCheckouts: options.openCheckouts })
                .pipe(
                  Effect.catch((error) =>
                    host.gone() ? inServer.worktrees.list(repoPath, options) : Effect.fail(error),
                  ),
                ),
        ),
      baseBranches: read(host.worktrees.baseBranches, inServer.worktrees.baseBranches),
      create: either(host.worktrees.create, inServer.worktrees.create),
      remove: either(host.worktrees.remove, inServer.worktrees.remove),
      restore: either(host.worktrees.restore, inServer.worktrees.restore),
      pendingPermissions: read(
        host.worktrees.pendingPermissions,
        inServer.worktrees.pendingPermissions,
      ),
    },
    git,
    scan: Effect.suspend(() => (host.gone() ? inServer.scan : host.scan)),
    hello: host.hello,
  };
  return parts;
};

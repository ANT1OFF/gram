// A profile's workplace of repositories: each repository cloned once under the data folder and
// fetched after, and a worktree of it made for the thread on a branch of its own. A thread placed
// on a joined machine is cloned only there, by that machine's host with its own git settings and
// credentials: this server keeps no copy of its repositories and never reaches their remotes.
import {
  type Checkout,
  type CheckoutRequest,
  type HostId,
  InvalidState,
  type ProfileRepository,
  type ThreadId,
} from "@gram/contracts";
import { git, Proc, type ProcShape, realPathSync } from "@gram/git";
import * as Effect from "effect/Effect";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { withCloneLock } from "../host/clone-lock.ts";
import { cloneFolderOf, cloneIdentityOf, reposOn } from "../host/repos.ts";
import { excludeLaid } from "./lay.ts";

/** Where the clones a profile's repositories are worked from are kept, under the data folder. */
export const PROFILE_REPOS_DIR = "profile-repos";

/**
 * Where a thread placed on a joined machine is filed here, one folder per remote: a repository
 * that holds nothing but its `origin`, made without reaching the remote. The machine clones from
 * that address itself.
 */
export const PROFILE_ORIGINS_DIR = "profile-origins";

export interface ProfileRepositoriesDeps {
  readonly proc: ProcShape;
  /** The server's data folder (`ServerConfig.dataDir`). */
  readonly dataDir: string;
  /** Registers a clone as the project its thread is filed under. */
  readonly ensureProject: (input: { root: string; name: string }) => Effect.Effect<unknown>;
  /** Makes a worktree in a clone, under the one-thread-per-worktree guard (`ThreadCreator.prepare`). */
  readonly prepare: (
    request: CheckoutRequest,
    projectRoot: string,
  ) => Effect.Effect<Checkout, { readonly message: string }>;
  /** Takes back a worktree made for a thread that was then never created. */
  readonly discard: (checkout: Checkout) => Effect.Effect<void>;
  /** Added to git's environment for the clone; tests reach a local remote through it. */
  readonly gitEnv?: Readonly<Record<string, string>>;
}

/** The checkouts a thread works in: its own folder first, then the others. */
export interface RepositoryWorkplace {
  readonly projectRoot: string;
  readonly checkout: Checkout;
  readonly extraCheckouts: ReadonlyArray<Checkout>;
}

const refuse = (message: string) => new InvalidState({ message });

/** The branch a thread works on in a repository that names none: the thread's own. */
export const profileBranchOf = (threadId: ThreadId): string => `thread/${threadId.slice(0, 8)}`;

/**
 * The repositories under `root` that hold only an `origin`, at the same `<host>/<owner>/<name>`
 * folders clones are kept at. Made with `git init` and `git remote add`, which reach no remote, so
 * no credential is needed or used. One already there is kept only when its `origin` is the same
 * remote.
 */
export const originsOn = (proc: ProcShape, root: string) => {
  const on = Effect.provideService(Proc, proc);
  const run = (cwd: string, args: ReadonlyArray<string>) =>
    on(git(cwd, args, { timeoutMs: 10_000 })).pipe(
      Effect.mapError((error) => refuse(error.message)),
      Effect.flatMap((out) =>
        out.status === 0
          ? Effect.succeed(out)
          : Effect.fail(refuse(`git ${args[0]} failed here: ${out.stderr.trim().slice(0, 300)}`)),
      ),
    );
  return (url: string): Effect.Effect<{ readonly path: string }, InvalidState> => {
    const filed = cloneFolderOf(url);
    const identity = cloneIdentityOf(url);
    if ("error" in filed || identity === undefined)
      return Effect.fail(refuse("error" in filed ? filed.error : `${url} can't be cloned.`));
    const dest = join(root, filed.folder);
    // Every folder from `root` down is a real folder of its own, never a link.
    const contained = () => {
      let at = root;
      for (const part of filed.folder.split(sep)) {
        at = join(at, part);
        const stat = lstatSync(at, { throwIfNoEntry: false });
        if (stat === undefined) return true;
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      }
      return true;
    };
    const outside = refuse(`${dest} isn't a folder of its own under ${root}.`);
    return withCloneLock(
      dest,
      Effect.gen(function* () {
        if (!contained()) return yield* outside;
        if (existsSync(dest)) {
          const stored = yield* run(dest, [
            "config",
            "--local",
            "--no-includes",
            "--get",
            "remote.origin.url",
          ]).pipe(Effect.orElseSucceed(() => undefined));
          if (stored === undefined || cloneIdentityOf(stored.stdout.trim()) !== identity)
            return yield* refuse(`${dest} already holds a different origin.`);
          return { path: realPathSync(dest) };
        }
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        const partial = `${dest}.origin-${randomBytes(4).toString("hex")}`;
        yield* Effect.gen(function* () {
          yield* run(dirname(dest), ["init", "--quiet", partial]);
          yield* run(partial, ["remote", "add", "origin", url]);
          if (!contained()) return yield* outside;
          renameSync(partial, dest);
        }).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Success"
              ? Effect.void
              : Effect.sync(() => rmSync(partial, { recursive: true, force: true })),
          ),
        );
        return { path: realPathSync(dest) };
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.fail(refuse(defect instanceof Error ? defect.message : String(defect))),
        ),
      ),
    );
  };
};

/**
 * Files the repository `url` names under the data folder as an origin alone, made without reaching
 * the remote: how a server that runs no work itself takes a repository, for the machine a thread is
 * placed on to clone with its own credentials. The project's name is the repository's.
 */
export const fileOrigin = (proc: ProcShape, dataDir: string, url: string) =>
  originsOn(
    proc,
    join(dataDir, PROFILE_ORIGINS_DIR),
  )(url).pipe(Effect.map(({ path }) => ({ path, name: originName(path) })));

/** The project name of a clone or origin kept at a `<host>/<owner>/<name>+<identity>` folder. */
export const originName = (path: string): string => basename(path).split("+")[0] || path;

export const makeProfileRepositories = (deps: ProfileRepositoriesDeps) => {
  const on = Effect.provideService(Proc, deps.proc);
  const repos = reposOn(deps.proc, join(deps.dataDir, PROFILE_REPOS_DIR), deps.gitEnv);
  const origins = originsOn(deps.proc, join(deps.dataDir, PROFILE_ORIGINS_DIR));

  /**
   * What `ref` names in the clone, as a worktree's base takes it: the remote's branch of that name
   * as just fetched, else a tag or a commit. Never a silent fallback to the default branch, since
   * work on the wrong base looks like work.
   */
  const baseOf = (clone: string, ref: string) =>
    Effect.gen(function* () {
      for (const name of [`origin/${ref}`, ref]) {
        const found = yield* on(
          git(clone, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]),
        ).pipe(
          Effect.map((out) => out.status === 0),
          Effect.orElseSucceed(() => false),
        );
        if (found) return name;
      }
      return yield* refuse(`${ref} isn't a branch, tag or commit of that repository.`);
    });

  const one = (threadId: ThreadId, repository: ProfileRepository, machine: HostId | undefined) =>
    Effect.gen(function* () {
      // On a joined machine the machine clones, fetches and resolves the ref itself (a branch to
      // its origin's tip as just fetched, else a tag or a commit), so nothing here reaches the
      // remote. Here, the clone is this server's own.
      const { path: clone } =
        machine === undefined
          ? yield* repos
              .ensure(repository.url)
              .pipe(Effect.mapError((error) => refuse(error.message)))
          : yield* origins(repository.url);
      const base =
        repository.ref === undefined
          ? undefined
          : machine === undefined
            ? yield* baseOf(clone, repository.ref)
            : repository.ref;
      yield* deps.ensureProject({ root: clone, name: originName(clone) });
      const checkout = yield* deps
        .prepare(
          {
            kind: "newWorktree",
            branch: repository.branch ?? profileBranchOf(threadId),
            ...(base === undefined ? {} : { base }),
            ...(machine === undefined ? {} : { hostId: machine }),
          },
          clone,
        )
        .pipe(Effect.mapError((error) => refuse(error.message)));
      return { clone, checkout };
    });

  /**
   * The thread's worktrees, one per repository, in the profile's order. All or none: a repository
   * that can't be cloned, or can't give a worktree, takes the worktrees made so far with it. With
   * `machine`, each worktree is made on that joined machine, from its own clone.
   */
  const prepare = (
    threadId: ThreadId,
    repositories: ReadonlyArray<ProfileRepository>,
    machine?: HostId,
  ): Effect.Effect<RepositoryWorkplace, InvalidState> =>
    Effect.gen(function* () {
      const made: Array<{ readonly clone: string; readonly checkout: Checkout }> = [];
      for (const repository of repositories) {
        made.push(
          yield* one(threadId, repository, machine).pipe(
            Effect.tapError(() =>
              Effect.forEach(made, (entry) => deps.discard(entry.checkout), { discard: true }),
            ),
          ),
        );
      }
      const [first, ...rest] = made;
      if (first === undefined)
        return yield* refuse("A workplace of repositories names at least one.");
      return {
        projectRoot: first.clone,
        checkout: first.checkout,
        extraCheckouts: rest.map((entry) => entry.checkout),
      };
    });

  const exclude = (checkout: string, laid: ReadonlyArray<string>) =>
    excludeLaid(deps.proc, checkout, laid);

  return { prepare, exclude, discard: deps.discard };
};

export type ProfileRepositories = ReturnType<typeof makeProfileRepositories>;

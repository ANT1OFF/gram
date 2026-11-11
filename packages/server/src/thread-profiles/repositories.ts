// A profile's workplace of repositories, on this machine: each repository cloned once under the
// data folder and fetched after, and a worktree of it made for the thread on a branch of its own.
import {
  type Checkout,
  type CheckoutRequest,
  InvalidState,
  type ProfileRepository,
  type ThreadId,
} from "@gram/contracts";
import { git, Proc, type ProcShape } from "@gram/git";
import * as Effect from "effect/Effect";
import { basename, join } from "node:path";
import { reposOn } from "../host/repos.ts";
import { excludeLaid } from "./lay.ts";

/** Where the clones a profile's repositories are worked from are kept, under the data folder. */
export const PROFILE_REPOS_DIR = "profile-repos";

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

export const makeProfileRepositories = (deps: ProfileRepositoriesDeps) => {
  const on = Effect.provideService(Proc, deps.proc);
  const repos = reposOn(deps.proc, join(deps.dataDir, PROFILE_REPOS_DIR), deps.gitEnv);

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

  const one = (threadId: ThreadId, repository: ProfileRepository) =>
    Effect.gen(function* () {
      const { path: clone } = yield* repos
        .ensure(repository.url)
        .pipe(Effect.mapError((error) => refuse(error.message)));
      const base = repository.ref === undefined ? undefined : yield* baseOf(clone, repository.ref);
      yield* deps.ensureProject({ root: clone, name: basename(clone).split("+")[0] ?? clone });
      const checkout = yield* deps
        .prepare(
          {
            kind: "newWorktree",
            branch: repository.branch ?? profileBranchOf(threadId),
            ...(base === undefined ? {} : { base }),
          },
          clone,
        )
        .pipe(Effect.mapError((error) => refuse(error.message)));
      return { clone, checkout };
    });

  /**
   * The thread's worktrees, one per repository, in the profile's order. All or none: a repository
   * that can't be cloned, or can't give a worktree, takes the worktrees made so far with it.
   */
  const prepare = (
    threadId: ThreadId,
    repositories: ReadonlyArray<ProfileRepository>,
  ): Effect.Effect<RepositoryWorkplace, InvalidState> =>
    Effect.gen(function* () {
      const made: Array<{ readonly clone: string; readonly checkout: Checkout }> = [];
      for (const repository of repositories) {
        made.push(
          yield* one(threadId, repository).pipe(
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

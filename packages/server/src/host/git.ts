import {
  checkoutPresent,
  type GitStateChange,
  localGitState,
  Proc,
  type ProcError,
  type ProcShape,
  watchGitState,
  type WatchOptions,
} from "@gram/git";
import type { GitState } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * A machine's checkouts' local git state: read, checked for presence, and watched. The network
 * tier (the PR badge, the fetch behind the rebase signal) stays with the control plane.
 */
export interface HostGit {
  /** A checkout's branch, changes and HEAD. */
  readonly local: (cwd: string) => Effect.Effect<GitState, ProcError>;
  /** Whether a checkout's folder is there; false only when it is definitely gone. */
  readonly present: (cwd: string) => Effect.Effect<boolean>;
  /** Each checkout's local state as it changes. */
  readonly watch: (
    paths: ReadonlyArray<string>,
    options?: WatchOptions,
  ) => Stream.Stream<GitStateChange>;
}

export const gitOn = (proc: ProcShape): HostGit => ({
  local: (cwd) => localGitState(cwd).pipe(Effect.provideService(Proc, proc)),
  present: checkoutPresent,
  watch: (paths, options) => watchGitState(paths, options).pipe(Stream.provideService(Proc, proc)),
});

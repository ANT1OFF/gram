import {
  git,
  isValidGitRefCharset,
  Proc,
  type ProcShape,
  WorktreeError,
  type Worktrees,
} from "@gram/git";
import * as Effect from "effect/Effect";
import { HOST_REPO_GIT_ENV } from "./repos.ts";
import { redactUrlCredentials } from "./remote-url.ts";

/** Joined clones must honor an explicit base, including branches absent from a narrow refspec.
 * Keep this at the host boundary: its refs and credentials decide, never the main checkout's. */
export const cloneWorktrees = (
  proc: ProcShape,
  worktrees: Worktrees["Service"],
  extraEnv: Readonly<Record<string, string>> = {},
): Worktrees["Service"] => {
  const resolveBase = (repo: string, raw: string) =>
    Effect.gen(function* () {
      const base = raw.trim();
      const unavailable = () =>
        new WorktreeError({
          reason: "invalidRequest",
          dirty: false,
          message: `Base ${base} isn't available on this machine. Push the branch to origin, or choose a base present here.`,
        });
      if (!isValidGitRefCharset(base)) return yield* unavailable();
      const remote = base.startsWith("refs/remotes/origin/")
        ? base.slice("refs/remotes/origin/".length)
        : base.startsWith("origin/")
          ? base.slice("origin/".length)
          : undefined;
      // A local branch, tag, HEAD or commit may be explicitly selected as it exists on this host.
      if (remote === undefined) {
        const exists = yield* git(repo, [
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${base}^{commit}`,
        ]);
        if (exists.status === 0) return base;
        if (base.startsWith("refs/") || /^[a-f0-9]{40,64}$/i.test(base))
          return yield* unavailable();
      }
      const name = remote ?? base;
      const valid = yield* git(repo, ["check-ref-format", `refs/heads/${name}`]);
      if (valid.status !== 0) return yield* unavailable();
      const fetched = yield* git(
        repo,
        [
          "-c",
          "credential.interactive=false",
          "fetch",
          "--quiet",
          "origin",
          `+refs/heads/${name}:refs/remotes/origin/${name}`,
        ],
        { timeoutMs: 2 * 60_000, env: { ...HOST_REPO_GIT_ENV, ...extraEnv } },
      );
      if (fetched.status !== 0) return yield* unavailable();
      return `origin/${name}`;
    }).pipe(
      Effect.provideService(Proc, proc),
      Effect.mapError((error) =>
        error._tag === "WorktreeError"
          ? error
          : new WorktreeError({
              reason: "failed",
              dirty: false,
              message: redactUrlCredentials(error.message),
            }),
      ),
    );
  return {
    ...worktrees,
    create: (request) =>
      Effect.gen(function* () {
        const base =
          request.base === undefined
            ? undefined
            : yield* resolveBase(request.repoPath, request.base);
        return yield* worktrees.create({ ...request, ...(base === undefined ? {} : { base }) });
      }),
  };
};

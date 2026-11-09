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
import { withCloneLock } from "./clone-lock.ts";

const tip = (repo: string, ref: string) =>
  git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).pipe(
    Effect.map((out) =>
      out.status === 0 && /^[a-f0-9]{40,64}$/i.test(out.stdout.trim())
        ? out.stdout.trim()
        : undefined,
    ),
  );

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
          message: `Base ${redactUrlCredentials(base)} isn't available on this machine. Push the branch to origin, or choose a base present here.`,
        });
      if (!isValidGitRefCharset(base)) return yield* unavailable();
      const remote = base.startsWith("refs/remotes/origin/")
        ? base.slice("refs/remotes/origin/".length)
        : base.startsWith("origin/")
          ? base.slice("origin/".length)
          : undefined;
      if (remote === undefined) {
        const oid = yield* tip(repo, base);
        if (oid !== undefined) {
          const local = yield* tip(repo, `refs/heads/${base}`);
          const tracked =
            local === undefined ? undefined : yield* tip(repo, `refs/remotes/origin/${base}`);
          // A default branch created by clone stays at its original tip. Prefer its refreshed
          // origin when it contains that local tip; keep an explicitly selected local branch's
          // additional/divergent work, and local tags, HEAD and commits.
          if (local === undefined || tracked === undefined) return { ref: base, oid };
          const ancestor = yield* git(repo, ["merge-base", "--is-ancestor", local, tracked]);
          if (ancestor.status === 1) return { ref: base, oid };
          if (ancestor.status !== 0)
            return yield* new WorktreeError({
              reason: "failed",
              dirty: false,
              message: `Couldn't compare base ${base} with its origin on this machine.`,
            });
        } else if (base.startsWith("refs/") || /^[a-f0-9]{40,64}$/i.test(base))
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
        {
          timeoutMs: 2 * 60_000,
          env: { ...HOST_REPO_GIT_ENV, ...extraEnv, LC_ALL: "C" },
        },
      );
      if (fetched.status !== 0) {
        if (fetched.stderr.includes("couldn't find remote ref")) return yield* unavailable();
        return yield* new WorktreeError({
          reason: "failed",
          dirty: false,
          message: `Couldn't fetch base ${base} from origin on this machine: ${redactUrlCredentials(fetched.stderr.trim()).slice(0, 300) || "git fetch failed"}. Check the machine's network and repository access.`,
        });
      }
      const ref = `origin/${name}`;
      const oid = yield* tip(repo, `refs/remotes/${ref}`);
      return oid === undefined ? yield* unavailable() : { ref, oid };
    });
  return {
    ...worktrees,
    create: (request) =>
      withCloneLock(
        request.repoPath,
        Effect.gen(function* () {
          if (request.base === undefined) return yield* worktrees.create(request);
          const base = yield* resolveBase(request.repoPath, request.base);
          const existing =
            request.branch === undefined
              ? undefined
              : yield* tip(request.repoPath, `refs/heads/${request.branch}`);
          const created = yield* worktrees.create({ ...request, base: base.oid });
          // A pre-existing branch is checked out as-is; its historical base isn't known here.
          const { base: _base, ...checkout } = created.checkout;
          return {
            ...created,
            checkout: existing === undefined ? { ...checkout, base: base.ref } : checkout,
          };
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
        ),
      ),
  };
};

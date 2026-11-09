// A project's check of a pull request, run on this joined machine for the main Gram, which keeps
// the record. The source is isolated as the main Gram's own checks isolate it (`LocalChecksLive`):
// the head is merged onto its base (`git merge-tree`) in a bare repository of the host's own, fed
// only by fetch from the machine's clone, committed to a throwaway commit and checked out in a
// fresh worktree outside every checkout. Nothing an agent writes into its worktree reaches it.
//
// Each run is taken once per id, so a control plane whose connection dropped while it ran asks
// again under the same id and joins it, or hears how it ended; a host that restarted meanwhile has
// no run of that id and starts it again from the start.

import { type HostCheckResult, HostFailed } from "@gram/contracts";
import { git, type ProcOutput, type ProcShape, Proc } from "@gram/git";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import {
  isGitControl,
  type LocalCheckOutcome,
  type LocalCheckRun,
  readTail,
  spawnCheck,
} from "../git/check-process.ts";

/** What the control plane asks the host to check. */
export interface HostCheckRequest {
  readonly id: string;
  readonly path: string;
  readonly repoRoot?: string | undefined;
  readonly head: string;
  readonly base: string;
  readonly command: string;
  readonly setup?: string | undefined;
  readonly timeoutMs: number;
}

export interface HostChecks {
  readonly run: (request: HostCheckRequest) => Effect.Effect<HostCheckResult, HostFailed>;
}

/** Runs the command in the prepared worktree: `spawnCheck` live, a test's own otherwise. */
export type HostCheckRunner = (
  dir: string,
  log: string,
  run: LocalCheckRun,
) => Effect.Effect<LocalCheckOutcome>;

const liveRunner: HostCheckRunner = (dir, log, run) =>
  // The service's own environment and PATH, which `gram-host service install` took from the
  // login shell.
  spawnCheck(dir, log, { base: process.env, pathValue: "" }, run);

const SHA = /^[a-f0-9]{40}$/;

/** How long a finished run's result is kept for a control plane that asks again. */
const KEEP_MS = 30 * 60_000;
/** At most this many finished results are kept. */
const KEEP_MOST = 32;

const fixedIdentity = {
  GIT_AUTHOR_NAME: "Gram",
  GIT_AUTHOR_EMAIL: "gram@localhost",
  GIT_COMMITTER_NAME: "Gram",
  GIT_COMMITTER_EMAIL: "gram@localhost",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

const unstartable = (reason: string): LocalCheckOutcome => ({
  ok: false,
  reason,
  failure: { kind: "unstartable" },
});

/**
 * Git as the check's source is made with it: no git variable the host inherited points it at
 * another repository, and no replace ref or graft changes what a commit names.
 */
const isolatedGit =
  (proc: ProcShape) =>
  (
    cwd: string,
    args: ReadonlyArray<string>,
    env?: Record<string, string>,
  ): Effect.Effect<ProcOutput | undefined> =>
    git(cwd, args, {
      omitEnv: isGitControl,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_GRAFT_FILE: "/dev/null",
        ...env,
      },
    }).pipe(
      Effect.provideService(Proc, proc),
      Effect.option,
      Effect.map((out) => (out._tag === "Some" ? out.value : undefined)),
    );

/**
 * The host's checks, kept in `dir`: one at a time on this machine, whichever control plane asks,
 * each id run once while its result is kept.
 */
export const checksOn = (
  proc: ProcShape,
  dir: string,
  runner: HostCheckRunner = liveRunner,
  now: () => number = Date.now,
): Effect.Effect<HostChecks, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fibers = yield* FiberMap.make<string>();
    const slot = yield* Semaphore.make(1);
    const runs = new Map<
      string,
      { readonly done: Deferred.Deferred<HostCheckResult>; endedAt?: number }
    >();
    const work = nodePath.join(dir, "work");
    /**
     * Before the first run: what a host that stopped mid-check left is removed, and its worktree
     * links pruned as each repository is next used.
     */
    let swept = false;
    const sweep = Effect.sync(() => {
      if (swept) return;
      swept = true;
      rmSync(work, { recursive: true, force: true });
    });

    const g = isolatedGit(proc);
    const commonDirOf = (folder: string) =>
      g(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
        Effect.map((out) => (out?.status === 0 ? out.stdout.trim() : undefined)),
      );
    const hasCommit = (repo: string, sha: string) =>
      g(repo, ["cat-file", "-e", `${sha}^{commit}`]).pipe(Effect.map((out) => out?.status === 0));

    /** The source and the outcome of one run: what the control plane records. */
    const execute = (request: HostCheckRequest) =>
      Effect.gen(function* () {
        const host = hostname();
        const result = (
          outcome: LocalCheckOutcome,
          more: { tree?: string | null; mergedCommit?: string; log?: string } = {},
        ): HostCheckResult => ({
          tree: more.tree ?? null,
          ...(more.mergedCommit === undefined ? {} : { mergedCommit: more.mergedCommit }),
          ok: outcome.ok,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
          ...(more.log === undefined || more.log === "" ? {} : { log: more.log }),
          host,
        });
        const source =
          (yield* commonDirOf(request.path)) ??
          (request.repoRoot === undefined ? undefined : yield* commonDirOf(request.repoRoot));
        if (source === undefined)
          return result(unstartable("the checkout and its clone aren't on this machine"));
        const own = nodePath.join(
          dir,
          "repos",
          `${createHash("sha256").update(source).digest("hex").slice(0, 16)}.git`,
        );
        if (!existsSync(nodePath.join(own, "HEAD"))) {
          yield* Effect.sync(() => mkdirSync(own, { recursive: true }));
          yield* g(own, ["init", "--quiet", "--bare", "--template=", own]);
        }
        yield* g(own, ["worktree", "prune"]);
        const take = (sha: string) =>
          g(own, [
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--no-tags",
            "--quiet",
            pathToFileURL(source).href,
            sha,
          ]);
        for (const sha of [request.head, request.base]) {
          if (yield* hasCommit(own, sha)) continue;
          yield* take(sha);
          if (yield* hasCommit(own, sha)) continue;
          // The clone may not have it yet: the base moved on its remote since it last fetched.
          yield* g(source, ["fetch", "--no-tags", "--quiet", "origin", sha]);
          yield* take(sha);
          if (!(yield* hasCommit(own, sha)))
            return result(
              unstartable(`${sha.slice(0, 7)} isn't in this machine's clone, even after fetching`),
            );
        }
        const merged = yield* g(own, [
          "merge-tree",
          "--write-tree",
          "--no-messages",
          request.base,
          request.head,
        ]);
        if (merged === undefined || (merged.status !== 0 && merged.status !== 1))
          return result(unstartable("couldn't merge the head onto its base"));
        if (merged.status === 1)
          return result({
            ok: false,
            reason: "the branch conflicts with its base; merge or rebase it first",
            failure: { kind: "conflict" },
          });
        const tree = merged.stdout.split("\n")[0]!.trim();
        if (!SHA.test(tree)) return result(unstartable("couldn't merge the head onto its base"));
        const commit = yield* g(
          own,
          [
            "commit-tree",
            tree,
            "-p",
            request.base,
            "-p",
            request.head,
            "-m",
            `Gram local check of ${request.head} on ${request.base}`,
          ],
          fixedIdentity,
        );
        const sha = commit?.status === 0 ? commit.stdout.trim() : undefined;
        if (sha === undefined || !SHA.test(sha))
          return result(unstartable("couldn't commit the merged tree"), { tree });
        yield* Effect.sync(() => mkdirSync(work, { recursive: true }));
        const folder = yield* Effect.sync(() =>
          mkdtempSync(nodePath.join(work, `${request.head.slice(0, 12)}-`)),
        );
        const src = nodePath.join(folder, "src");
        const log = nodePath.join(folder, "check.log");
        const remove = Effect.gen(function* () {
          yield* g(own, ["worktree", "remove", "--force", src]);
          yield* Effect.sync(() => rmSync(folder, { recursive: true, force: true }));
          yield* g(own, ["worktree", "prune"]);
        });
        return yield* Effect.acquireUseRelease(
          // No checkout hook may change the tree after git wrote it.
          g(own, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", src, sha]),
          (added) =>
            added?.status === 0
              ? runner(src, log, {
                  isolation: "host",
                  command: request.command,
                  ...(request.setup === undefined ? {} : { setup: request.setup }),
                  timeoutMs: request.timeoutMs,
                }).pipe(
                  Effect.map((outcome) =>
                    result(outcome, { tree, mergedCommit: sha, log: readTail(log) }),
                  ),
                )
              : Effect.succeed(
                  result(unstartable("couldn't check out the merged tree"), {
                    tree,
                    mergedCommit: sha,
                  }),
                ),
          () => remove,
        );
      }).pipe(
        Effect.catchDefect((defect) =>
          Effect.succeed<HostCheckResult>({
            tree: null,
            ok: false,
            reason: `the host's check failed to run: ${String(defect)}`,
            failure: { kind: "unstartable" },
            host: hostname(),
          }),
        ),
      );

    /** Forgets finished results past their keeping, and the oldest past the bound. */
    const prune = () => {
      const ended = [...runs]
        .filter(([, run]) => run.endedAt !== undefined)
        .toSorted(([, a], [, b]) => a.endedAt! - b.endedAt!);
      ended.forEach(([id, run], index) => {
        if (now() - run.endedAt! > KEEP_MS || ended.length - index > KEEP_MOST) runs.delete(id);
      });
    };

    return {
      run: (request) =>
        Effect.gen(function* () {
          if (!SHA.test(request.head) || !SHA.test(request.base))
            return yield* new HostFailed({ message: "A check names its head and base by SHA." });
          if (request.command.trim() === "")
            return yield* new HostFailed({ message: "A check needs a command." });
          prune();
          let run = runs.get(request.id);
          if (run === undefined) {
            const done = yield* Deferred.make<HostCheckResult>();
            const entry: { readonly done: typeof done; endedAt?: number } = { done };
            run = entry;
            runs.set(request.id, entry);
            // Runs in the host's scope, not the caller's: a dropped connection doesn't stop it.
            yield* FiberMap.run(
              fibers,
              request.id,
              slot
                .withPermits(1)(Effect.andThen(sweep, execute(request)))
                .pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      entry.endedAt = now();
                    }).pipe(
                      Effect.andThen(
                        Exit.isSuccess(exit)
                          ? Deferred.succeed(done, exit.value)
                          : // Interrupted as the host stops: no word of how it would have ended.
                            Deferred.succeed(done, {
                              tree: null,
                              ok: false,
                              reason: "the host stopped while it ran",
                              failure: { kind: "stopped" },
                              host: hostname(),
                            }),
                      ),
                    ),
                  ),
                ),
            );
          }
          return yield* Deferred.await(run.done);
        }),
    };
  });

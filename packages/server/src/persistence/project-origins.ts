// Which repository a project is: the identity of its `origin` as it was when the project was added
// (`Project.originIdentity`). A repository's reach (`git/repo-reach.ts`) and a merge freeze's
// workspace (`git/merge-freezes.ts`) go by it, never by the origin the folder's git config names
// later, which an agent working there can rewrite with `git remote set-url`.

import { Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { originIdentityAt } from "../host/repos.ts";
import type { SqlClient } from "../platform/unstable.ts";

/** `origin_identity` of a project that had no origin Gram could read when it was added. */
export const NO_ORIGIN = "";

/**
 * The identity of the origin of the repository at `dir` on this machine, `undefined` outside a repo
 * or for a remote the host doesn't clone. Read with the caller's `Proc` where it has one, so a
 * test's or an embedder's process layer is the one that runs git.
 */
export const originIdentityOfFolder = (dir: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const proc = yield* Effect.serviceOption(Proc);
    const read = originIdentityAt(dir);
    return yield* Option.isSome(proc)
      ? read.pipe(Effect.provideService(Proc, proc.value))
      : read.pipe(Effect.provide(ProcLive));
  });

/**
 * Records the origin of each project added before origins were (`0017_project_origins`), read once
 * as the store loads; one without an origin then is recorded as having none (`NO_ORIGIN`), so no
 * later load reads a git config an agent may have rewritten by then.
 */
export const backfillProjectOrigins = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      root: string;
      repo_root: string | null;
    }>`SELECT id, root, repo_root FROM projects WHERE origin_identity IS NULL`;
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const identity = yield* originIdentityOfFolder(row.repo_root ?? row.root);
          yield* sql`UPDATE projects SET origin_identity = ${identity ?? NO_ORIGIN}
            WHERE id = ${row.id} AND origin_identity IS NULL`;
        }),
      { concurrency: 8, discard: true },
    );
  });

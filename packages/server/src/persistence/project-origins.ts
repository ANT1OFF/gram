import { git, Proc, ProcLive } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { cloneIdentityOf } from "../host/repos.ts";
import type { SqlClient } from "../platform/unstable.ts";

/** `origin_identity` of a project git said had no origin when it was added; `NULL` is unread. */
export const NO_ORIGIN = "";

/**
 * What `dir`'s origin is to record: its identity, `NO_ORIGIN` when git says it has none (or one the
 * host doesn't clone), or `null` when it couldn't be read (a timeout, a missing folder, a git
 * error), which is left to be read again rather than recorded as none for good. Read with the
 * caller's `Proc` where it has one, so a test's or an embedder's process layer is the one that runs
 * git.
 */
export const originIdentityOfFolder = (dir: string): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const proc = yield* Effect.serviceOption(Proc);
    const read = git(dir, ["config", "--get", "remote.origin.url"], { timeoutMs: 2_000 }).pipe(
      Effect.map((out): string | null => {
        const url = out.stdout.trim();
        if (out.status === 0 && url !== "") return cloneIdentityOf(url) ?? NO_ORIGIN;
        return out.status === 1 && url === "" ? NO_ORIGIN : null;
      }),
      Effect.orElseSucceed(() => null),
    );
    return yield* Option.isSome(proc)
      ? read.pipe(Effect.provideService(Proc, proc.value))
      : read.pipe(Effect.provide(ProcLive));
  });

/** A project row's `originIdentity`: absent while unread (`NULL`) and when it has none. */
export const originOfRow = (stored: string | null | undefined): { originIdentity?: string } =>
  stored == null || stored === NO_ORIGIN ? {} : { originIdentity: stored };

/**
 * The origin `registerProject` records for the project at a root, whose row is `row`: one being
 * added has its origin at `dir` read (`originIdentityOfFolder`). A known one keeps the origin it
 * was added with; only one whose read failed then has it read and recorded now, once. `null`
 * means nothing to record.
 */
export const originToRecord = (
  sql: SqlClient.SqlClient,
  row: { readonly id: string; readonly origin_identity?: string | null } | undefined,
  dir: string,
) =>
  Effect.gen(function* () {
    if (row !== undefined && row.origin_identity != null) return null;
    const identity = yield* originIdentityOfFolder(dir);
    if (row === undefined || identity === null) return identity;
    yield* sql`UPDATE projects SET origin_identity = ${identity}
      WHERE id = ${row.id} AND origin_identity IS NULL`;
    return null;
  });

/**
 * Records the origin of each project whose origin isn't recorded: one added before origins were
 * (`0017_project_origins`), or one whose read failed. Read once as the store loads, trusting the
 * origin as it is then; a project whose read fails again stays unrecorded for the next load.
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
          if (identity === null) return;
          yield* sql`UPDATE projects SET origin_identity = ${identity}
            WHERE id = ${row.id} AND origin_identity IS NULL`;
        }),
      { concurrency: 8, discard: true },
    );
  });

import { existsSync } from "node:fs";
import { devNull } from "node:os";
import { join } from "node:path";
import { git, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { redactUrlCredentials } from "./remote-url.ts";
import { cloneIdentityOf, repositoryOfIdentity } from "./repos.ts";

/** Whether two clone identities name one repository: its host, owner and name, by any transport. */
export const sameRepo = (a: string, b: string) => {
  const repo = repositoryOfIdentity(a);
  return repo !== undefined && repo === repositoryOfIdentity(b);
};

/** What a folder's origin is held to: its name for messages, and the origin's recorded identity. */
export interface OriginRecord {
  readonly name: string;
  /** `cloneIdentityOf`'s; absent when none is recorded. */
  readonly originIdentity?: string | undefined;
}

const REPOSITORY_CONFIG_ONLY = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

const EFFECTIVE_ORIGINS = [
  ["remote", "get-url", "--all", "origin"],
  ["remote", "get-url", "--push", "--all", "origin"],
] as const;

const NO_SUCH_REMOTE = 2;

const LFS_ENDPOINTS = String.raw`^(lfs\.url|lfs\.pushurl|remote\.origin\.lfsurl|remote\.origin\.lfspushurl)$`;

const lfsRepository = (url: string) => url.replace(/\/info\/lfs\/?$/, "");

const reachChecked = <E>(
  record: OriginRecord,
  url: string,
  refuse: (message: string) => Effect.Effect<void, E>,
): Effect.Effect<void, E> => {
  const identity = cloneIdentityOf(url);
  const recorded = record.originIdentity;
  if (identity === undefined && recorded === undefined) return Effect.void;
  if (identity !== undefined && recorded !== undefined && sameRepo(recorded, identity))
    return Effect.void;
  return refuse(
    recorded === undefined
      ? `Gram has no origin recorded for ${record.name}, and its folder sends git to ${redactUrlCredentials(url).slice(0, 200)}. If its origin couldn't be read when it was added, Gram reads it again when the next thread starts in it or Gram starts; if it had none, remove the project and add it again.`
      : `${record.name}'s folder sends git to ${redactUrlCredentials(url).slice(0, 200)}, which isn't the repository it was added with. Set its origin back, or remove the project and add it again.`,
  );
};

/**
 * Where git in `dir` fetches `origin` from and pushes it to, after the repository's own
 * `url.*.insteadOf`, `url.*.pushInsteadOf` and `remote.origin.pushurl` (the user's own config is
 * left out, as theirs to set), and where LFS sends origin's large files (the repository's
 * `lfs.url`, `remote.origin.lfsurl` and their push forms, and the folder's committed
 * `.lfsconfig`), each checked against `record` (`reachChecked`): an agent that leaves the stored
 * URL alone but sends git elsewhere goes to `refuse` too. So does a folder git can't answer for (a
 * timeout, an error), since nothing then says where it goes; a folder with no origin, where none is
 * recorded, has nothing to check.
 */
export const effectiveOriginsReach = <E>(
  record: OriginRecord,
  dir: string,
  refuse: (message: string) => Effect.Effect<void, E>,
): Effect.Effect<void, E, Proc> =>
  Effect.gen(function* () {
    const read = (args: ReadonlyArray<string>) =>
      git(dir, args, { timeoutMs: 2_000, env: REPOSITORY_CONFIG_ONLY }).pipe(Effect.option);
    for (const args of EFFECTIVE_ORIGINS) {
      const out = yield* read(args);
      if (
        Option.isSome(out) &&
        out.value.status === NO_SUCH_REMOTE &&
        record.originIdentity === undefined
      )
        continue;
      if (Option.isNone(out) || out.value.status !== 0) {
        yield* refuse(
          `Gram couldn't read where ${record.name}'s folder fetches and pushes origin, so it doesn't reach origin from it. Try again; if it keeps failing, check the folder's git config.`,
        );
        continue;
      }
      for (const line of out.value.stdout.split("\n")) {
        const url = line.trim();
        if (url !== "") yield* reachChecked(record, url, refuse);
      }
    }
    const lfsconfig = join(dir, ".lfsconfig");
    for (const args of [
      ["config", "--get-regexp", LFS_ENDPOINTS],
      ["config", "--file", lfsconfig, "--get-regexp", LFS_ENDPOINTS],
    ]) {
      if (args.includes("--file") && !existsSync(lfsconfig)) continue;
      const out = yield* read(args);
      if (Option.isSome(out) && out.value.status === 1 && out.value.stdout.trim() === "") continue;
      if (Option.isNone(out) || out.value.status !== 0) {
        yield* refuse(
          `Gram couldn't read where ${record.name}'s folder sends its large files (LFS), so it doesn't reach origin from it.`,
        );
        continue;
      }
      for (const line of out.value.stdout.split("\n")) {
        const url = line.trim().split(/\s+/).slice(1).join(" ");
        if (url !== "") yield* reachChecked(record, lfsRepository(url), refuse);
      }
    }
  });

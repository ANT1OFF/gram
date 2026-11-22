import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, type OriginUrls, type Proc } from "@gram/git";
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

const EFFECTIVE_ORIGINS = [
  ["remote", "get-url", "--all", "origin"],
  ["remote", "get-url", "--push", "--all", "origin"],
] as const;

const NO_SUCH_REMOTE = 2;

const LFS_ENDPOINTS = String.raw`^(lfs\.url|lfs\.pushurl|remote\.origin\.lfsurl|remote\.origin\.lfspushurl)$`;

const lfsRepository = (url: string) => url.replace(/\/info\/lfs\/?$/, "");

const MACHINE_REWRITES = String.raw`^url\..*\.(insteadof|pushinsteadof)$`;

/** One `url.<base>.insteadOf` (or `pushInsteadOf`) of the machine's: `base` stands for `prefix`. */
export interface MachineRewrite {
  readonly base: string;
  readonly prefix: string;
}

/** `git config --get-regexp`'s lines for `MACHINE_REWRITES`, as rewrites. */
const parseMachineRewrites = (stdout: string): ReadonlyArray<MachineRewrite> =>
  stdout.split("\n").flatMap((line) => {
    const match = /^url\.(.+)\.(?:insteadof|pushinsteadof) (.+)$/i.exec(line.trim());
    return match === null ? [] : [{ base: match[1]!, prefix: match[2]! }];
  });

/**
 * The URLs `url` stands for under the machine's own rewrites: for the longest base of theirs it
 * starts with, each prefix that base stands for, followed by the rest of `url`. Empty when none of
 * them rewrote to it.
 */
const unrewritten = (rewrites: ReadonlyArray<MachineRewrite>, url: string) => {
  const longest = rewrites
    .filter((rewrite) => rewrite.base !== "" && url.startsWith(rewrite.base))
    .reduce((most, rewrite) => Math.max(most, rewrite.base.length), 0);
  return longest === 0
    ? []
    : rewrites
        .filter((rewrite) => rewrite.base.length === longest && url.startsWith(rewrite.base))
        .map((rewrite) => rewrite.prefix + url.slice(longest));
};

/**
 * Whether `url` is what the machine's own rewrites make of a URL for the recorded repository, such
 * as a proxy that the machine sends every GitHub remote through: at least one URL it stands for
 * names that repository, and none names another. Anything else, another host's or another
 * repository's included, isn't.
 */
const rewrittenFrom = (
  rewrites: ReadonlyArray<MachineRewrite>,
  url: string,
  recorded: string,
): boolean => {
  const named = unrewritten(rewrites, url).flatMap((original) => {
    const identity = cloneIdentityOf(original);
    return identity === undefined ? [] : [identity];
  });
  return named.length > 0 && named.every((identity) => sameRepo(recorded, identity));
};

const reachChecked = <E, R>(
  record: OriginRecord,
  url: string,
  rewrites: Effect.Effect<ReadonlyArray<MachineRewrite>, never, R>,
  refuse: (message: string) => Effect.Effect<void, E>,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const identity = cloneIdentityOf(url);
    const recorded = record.originIdentity;
    if (identity === undefined && recorded === undefined) return;
    if (identity !== undefined && recorded !== undefined && sameRepo(recorded, identity)) return;
    if (recorded !== undefined && rewrittenFrom(yield* rewrites, url, recorded)) return;
    yield* refuse(
      recorded === undefined
        ? `Gram has no origin recorded for ${record.name}, and its folder sends git to ${redactUrlCredentials(url).slice(0, 200)}. If its origin couldn't be read when it was added, Gram reads it again when the next thread starts in it or Gram starts; if it had none, remove the project and add it again.`
        : `${record.name}'s folder sends git to ${redactUrlCredentials(url).slice(0, 200)}, which isn't the repository it was added with. Set its origin back, or remove the project and add it again.`,
    );
  });

/**
 * Where git in `dir` fetches `origin` from and pushes it to, after the repository's own
 * `url.*.insteadOf`, `url.*.pushInsteadOf` and `remote.origin.pushurl`, read with the same
 * config (the user's own included) as the git that then reaches it, and where LFS sends origin's large files (the repository's
 * `lfs.url`, `remote.origin.lfsurl` and their push forms, and the folder's committed
 * `.lfsconfig`), each checked against `record` (`reachChecked`): an agent that leaves the stored
 * URL alone but sends git elsewhere goes to `refuse` too. So does a folder git can't answer for (a
 * timeout, an error), since nothing then says where it goes; a folder with no origin, where none is
 * recorded, has nothing to check. Gives the first URL each way, for that git to be given in place
 * of `origin` (`remoteGit`), so the URL checked is the URL used.
 *
 * A URL that git's system configuration rewrote a URL for the recorded repository to (a machine
 * that sends every remote of a host through a proxy, by `url.<proxy>.insteadOf`) reaches that
 * repository too: the system configuration is the machine's, set for the process that runs this
 * git, where the folder's own and the user's could have been written by an agent. Only the system
 * configuration's rewrites count, and only back to the recorded repository.
 */
export const effectiveOriginsReach = <E>(
  record: OriginRecord,
  dir: string,
  refuse: (message: string) => Effect.Effect<void, E>,
): Effect.Effect<OriginUrls | undefined, E, Proc> =>
  Effect.gen(function* () {
    const read = (args: ReadonlyArray<string>) =>
      git(dir, args, { timeoutMs: 2_000 }).pipe(Effect.option);
    const first: Array<string | undefined> = [];
    let machine: ReadonlyArray<MachineRewrite> | undefined;
    const rewrites = Effect.gen(function* () {
      if (machine !== undefined) return machine;
      const out = yield* read(["config", "--system", "--get-regexp", MACHINE_REWRITES]);
      machine =
        Option.isSome(out) && out.value.status === 0 ? parseMachineRewrites(out.value.stdout) : [];
      return machine;
    });
    const checked = (url: string) => reachChecked(record, url, rewrites, refuse);
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
      const urls = out.value.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((url) => url !== "");
      for (const url of urls) yield* checked(url);
      first.push(urls[0]);
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
        if (url !== "") yield* checked(lfsRepository(url));
      }
    }
    const [fetch, push] = first;
    return fetch === undefined || push === undefined ? undefined : { fetch, push };
  });

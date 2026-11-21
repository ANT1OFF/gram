import {
  GitError,
  InvalidState,
  parseRepoRemote,
  remoteKey,
  remoteLabel,
  type CloneSuggestions,
  type Project,
  type RepoRemote,
} from "@gram/contracts";
import {
  gh,
  ghApi,
  git,
  remoteGit,
  splitGhInclude,
  TIER_MILLIS,
  type Proc,
  type ProcOutput,
} from "@gram/git";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import { expandHome, registerRepo } from "./folders.ts";

type Store = Pick<ThreadStoreShape, "listProjects" | "registerProject">;

const codeOf = (error: unknown) => (error as { code?: unknown } | undefined)?.code;

/** What a failed clone said, without git's "Cloning into '<the temp folder>'…" line. */
export const cloneFailure = (out: ProcOutput): string => {
  const lines = `${out.stderr}\n${out.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Cloning into"));
  return lines.join(" ") || `exited with ${out.status}`;
};

const GH_SIGNED_OUT = /gh auth login|GH_TOKEN environment variable/;

/**
 * Why a clone failed, retaining the process output needed to diagnose it. A `gh` with no login
 * says where to sign in rather than quoting gh's own advice, which names no machine.
 */
export const cloneFailureMessage = (label: string, out: ProcOutput): string =>
  GH_SIGNED_OUT.test(`${out.stderr}\n${out.stdout}`)
    ? `Couldn't clone ${label}: the GitHub CLI on the machine running Gram's server isn't signed in. Run \`gh auth login\` there, or paste the repository's git URL to clone with git's own credentials.`
    : `Couldn't clone ${label}: ${cloneFailure(out)}`;

const remotesOf = (root: string): Effect.Effect<ReadonlySet<string>, never, Proc> =>
  git(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]).pipe(
    Effect.map((out) => {
      const keys = new Set<string>();
      for (const line of out.stdout.split("\n")) {
        const url = line.trim().split(/\s+/)[1];
        const remote = url === undefined ? undefined : parseRepoRemote(url);
        if (remote !== undefined && !("error" in remote)) keys.add(remoteKey(remote));
      }
      return keys;
    }),
    Effect.orElseSucceed(() => new Set<string>()),
  );

const occupant = (path: string): "none" | "folder" | "file" => {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    return info === undefined ? "none" : info.isDirectory() ? "folder" : "file";
  } catch {
    return "folder";
  }
};

const isEmpty = (path: string): boolean => {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
};

const identityOf = (path: string): string | undefined => {
  try {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    return info?.isDirectory() === true ? `${info.dev}:${info.ino}` : undefined;
  } catch {
    return undefined;
  }
};

const cloneCommand = (remote: RepoRemote, into: string, cwd: string) =>
  remote.kind === "github"
    ? gh(cwd, ["repo", "clone", `${remote.owner}/${remote.repo}`, into], {
        timeoutMs: TIER_MILLIS.slow,
      })
    : remoteGit(cwd, ["clone", "--", remote.url, into], {
        tier: "slow",
        env: { GIT_ALLOW_PROTOCOL: "https:ssh" },
      });

const renameIntoPlace = (from: string, to: string) =>
  Effect.tryPromise({ try: () => rename(from, to), catch: (error) => error }).pipe(
    Effect.retry({
      while: (error) =>
        ["EPERM", "EACCES", "EBUSY"].includes(String(codeOf(error))) && !existsSync(to),
      schedule: Schedule.spaced("250 millis"),
      times: process.platform === "win32" ? 8 : 0,
    }),
  );

export interface CloneRequest {
  readonly remote: string;
  /** Overrides `cloneFolder`. */
  readonly into?: string | undefined;
  /** "Where new clones go", `~` unexpanded. */
  readonly cloneFolder: string;
  readonly home?: string | undefined;
}

/**
 * The project for the repository `request.remote` names, cloned into `<folder>/<repo>` unless a
 * clone of it is already there. Refuses a folder there holding anything else.
 */
export const cloneRepo = (
  store: Store,
  request: CloneRequest,
): Effect.Effect<Project, InvalidState | GitError, Proc> =>
  Effect.gen(function* () {
    const remote = parseRepoRemote(request.remote);
    if ("error" in remote) return yield* new InvalidState({ message: remote.error });
    const label = remoteLabel(remote);

    const folder = expandHome((request.into ?? request.cloneFolder).trim(), request.home);
    if (!isAbsolute(folder)) {
      return yield* new InvalidState({
        message: `Clones go in a folder named from the root or ~, not ${folder}. Change it in Settings → General.`,
      });
    }
    const base = resolve(folder);
    const target = join(base, remote.repo);
    const register = registerRepo(store, target, request.home).pipe(
      Effect.mapError((error) => new InvalidState({ message: error.message })),
      Effect.map(({ project }) => project),
    );

    const adopt = Effect.gen(function* () {
      const found = occupant(target);
      if (found === "none") return undefined;
      const remotes =
        found === "folder" && existsSync(join(target, ".git"))
          ? yield* remotesOf(target)
          : new Set<string>();
      if (remotes.has(remoteKey(remote))) return yield* register;
      if (found === "folder" && isEmpty(target)) {
        return yield* new InvalidState({
          message: `${target} already exists, empty, or is being cloned right now. Remove it, or change where new clones go in Settings → General.`,
        });
      }
      return yield* new InvalidState({
        message: `${target} already exists and isn't a clone of ${label}. Move it, or change where new clones go in Settings → General.`,
      });
    });
    const existing = yield* adopt;
    if (existing !== undefined) return existing;

    yield* Effect.tryPromise({
      try: () => mkdir(base, { recursive: true }),
      catch: () => new InvalidState({ message: `Couldn't create ${base} to clone into.` }),
    });
    const reserve = Effect.tryPromise({ try: () => mkdir(target), catch: codeOf }).pipe(
      Effect.map(() => ({ identity: identityOf(target), held: true })),
      Effect.catch((code) =>
        code === "EEXIST"
          ? Effect.succeed(undefined)
          : Effect.fail(new InvalidState({ message: `Couldn't write to ${base} to clone into.` })),
      ),
    );
    type Reservation = { readonly identity: string | undefined; held: boolean };
    const stillReserved = (reservation: Reservation) =>
      reservation.held && identityOf(target) === reservation.identity;

    const cloneInto = (reservation: Reservation) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(base, `.${remote.repo}.clone-`)),
          catch: () => new InvalidState({ message: `Couldn't write to ${base} to clone into.` }),
        }),
        (temp) =>
          Effect.gen(function* () {
            const out = yield* cloneCommand(remote, temp, base).pipe(
              Effect.mapError((error) =>
                error._tag === "ProcTimeout"
                  ? new GitError({
                      message: `Cloning ${label} took longer than 5 minutes, so it was stopped.`,
                    })
                  : new GitError({
                      message:
                        remote.kind === "github"
                          ? `Cloning ${label} needs the GitHub CLI (gh), which isn't installed or isn't on the PATH. Paste the repository's URL instead to clone it with git.`
                          : `Couldn't run git to clone ${label}.`,
                    }),
              ),
            );
            if (out.status !== 0) {
              return yield* new GitError({
                message: cloneFailureMessage(label, out),
              });
            }
            if (!stillReserved(reservation)) return false;
            if (process.platform === "win32") {
              const released = yield* Effect.tryPromise(() => rmdir(target)).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              );
              if (!released) return false;
              reservation.held = false;
            }
            const promoted = yield* renameIntoPlace(temp, target).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (promoted) reservation.held = false;
            return promoted;
          }),
        (temp) =>
          Effect.tryPromise(() => rm(temp, { recursive: true, force: true })).pipe(Effect.ignore),
      );

    const cloned = yield* Effect.acquireUseRelease(
      reserve,
      (reservation) => (reservation === undefined ? Effect.succeed(false) : cloneInto(reservation)),
      (reservation) =>
        reservation !== undefined && stillReserved(reservation)
          ? Effect.tryPromise(() => rmdir(target)).pipe(Effect.ignore)
          : Effect.void,
    );
    if (!cloned) return yield* adoptOrRefuse(adopt, target, label);
    return yield* register;
  });

const adoptOrRefuse = <E, R>(
  adopt: Effect.Effect<Project | undefined, E, R>,
  target: string,
  label: string,
): Effect.Effect<Project, E | InvalidState, R> =>
  adopt.pipe(
    Effect.flatMap((project) =>
      project === undefined
        ? Effect.fail(
            new InvalidState({
              message: `Couldn't clone ${label} into ${target}: something else was put there meanwhile.`,
            }),
          )
        : Effect.succeed(project),
    ),
  );

const SUGGESTIONS_TTL_MS = 10 * 60_000;

const SUGGESTION_PAGES = 20;

const repoPage = (page: number) => `user/repos?sort=pushed&per_page=100&page=${page}`;

/** The `rel="last"` page in a `gh api --include` header block's `Link`, else 1. */
export const lastPage = (headers: string | undefined): number => {
  const link = headers?.split(/\r?\n/).find((line) => /^link:/i.test(line));
  const last = link?.match(/[?&]page=(\d+)[^,]*rel="last"/);
  return last?.[1] === undefined ? 1 : Number.parseInt(last[1], 10);
};

const fullNames = (body: string): ReadonlyArray<string> =>
  body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * GitHub repositories to offer for cloning: every one the user can reach, most recently pushed
 * first, reused for ten minutes. The first page says how many there are and the rest are asked for
 * four at a time, which takes seconds where `--paginate`'s one after another took a dozen. Empty
 * without `gh` or when GitHub can't be asked, which is never an error: typing the name works just
 * the same. A later page that fails leaves the list short, so it isn't kept.
 */
export const makeCloneSuggestions = (cwd: string) => {
  let cached: { readonly at: number; readonly repos: ReadonlyArray<string> } | undefined;
  return Effect.gen(function* () {
    const now = Date.now();
    if (cached !== undefined && now - cached.at < SUGGESTIONS_TTL_MS)
      return { repos: cached.repos };
    const first = yield* gh(cwd, ["api", repoPage(1), "--jq", ".[].full_name", "--include"], {
      timeoutMs: 15_000,
    }).pipe(Effect.option);
    if (first._tag === "None" || first.value.status !== 0) return { repos: [] };
    const { headers, body } = splitGhInclude(first.value.stdout);
    const pages = Math.min(lastPage(headers), SUGGESTION_PAGES);
    const rest = yield* Effect.forEach(
      Array.from({ length: pages - 1 }, (_, i) => i + 2),
      (page) =>
        ghApi(cwd, [repoPage(page), "--jq", ".[].full_name"], { timeoutMs: 15_000 }).pipe(
          Effect.map((out) => (out.status === 0 ? fullNames(out.stdout) : undefined)),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 4 },
    );
    const repos = [...new Set([...fullNames(body), ...rest.flatMap((names) => names ?? [])])];
    if (rest.every((names) => names !== undefined)) cached = { at: now, repos };
    return { repos } satisfies CloneSuggestions;
  });
};

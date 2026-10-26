import {
  InvalidState,
  linkedCheckoutMessage,
  NotFound,
  notARepositoryMessage,
  type FolderListing,
  type Project,
  type RepositoryCandidate,
  type RepositoryCandidates,
} from "@gram/contracts";
import { git as runGit, projectRoot, projectRootKey, realPath, type Proc } from "@gram/git";
import * as Effect from "effect/Effect";
import { existsSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";

const FOLDER_LIMIT = 500;

export const expandHome = (path: string, home: string = homedir()): string =>
  path === "~"
    ? home
    : path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"))
      ? join(home, path.slice(2))
      : path;

/** A filesystem failure as a contract error with a message fit for the user, never the raw error. */
export const folderError = (
  error: unknown,
  path: string,
  platform: NodeJS.Platform = process.platform,
): NotFound | InvalidState => {
  const code = (error as { code?: unknown } | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new NotFound({ entity: "project", id: path, message: `Folder not found: ${path}` });
    case "ENOTDIR":
      return new InvalidState({ message: `Not a folder: ${path}` });
    case "EACCES":
    case "EPERM":
      return new InvalidState({
        message:
          platform === "darwin"
            ? `Gram can't read ${path}. Allow it in System Settings → Privacy & Security → Files & Folders.`
            : `Permission denied: ${path}`,
        access: { path, code: code === "EACCES" ? "EACCES" : "EPERM" },
      });
    default:
      return new InvalidState({ message: `Can't open ${path}` });
  }
};

/** Expands `~`, makes the path absolute, and checks it is an existing folder. */
export const resolveFolder = (
  input: string,
  home?: string,
): Effect.Effect<string, NotFound | InvalidState> => {
  const path = resolve(expandHome(input.trim(), home));
  return Effect.tryPromise({
    try: () => stat(path),
    catch: (error) => folderError(error, path),
  }).pipe(
    Effect.flatMap((info) =>
      info.isDirectory()
        ? Effect.succeed(path)
        : Effect.fail(new InvalidState({ message: `Not a folder: ${path}` })),
    ),
  );
};

/**
 * True unless the path is definitely gone; permission and other errors are left to the caller.
 * Synchronous, so snapshots stay deterministic under `TestClock`.
 */
export const folderExists = (path: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      return statSync(path, { throwIfNoEntry: false }) !== undefined;
    } catch {
      return true;
    }
  });

export const missingThreadFolder = (path: string) =>
  `This thread's folder no longer exists: ${path}`;

export interface BrowseOptions {
  readonly home?: string;
  readonly limit?: number;
}

/** What `folder`'s own `.git` is, as `repoFolder` reads it; `undefined` without one. */
const gitKind = (folder: string): FolderListing["git"] => {
  try {
    const git = statSync(join(folder, ".git"), { throwIfNoEntry: false });
    return git === undefined ? undefined : git.isDirectory() ? "repository" : "linked";
  } catch {
    // Not "no repository": adding the folder is what reports why it couldn't be read.
    return "unreadable";
  }
};

/**
 * Lists folders for the project picker. A path ending in `/` (or `~`) lists that folder; otherwise
 * the last segment is a prefix completed within its parent. Dotfolders show only when the prefix
 * starts with `.`.
 */
export const browseFolders = (
  input: string,
  options: BrowseOptions = {},
): Effect.Effect<FolderListing, NotFound | InvalidState> =>
  Effect.gen(function* () {
    const trimmed = input.trim() === "" ? "~/" : input.trim();
    const listWhole = trimmed === "~" || trimmed.endsWith("/") || trimmed.endsWith(sep);
    const expanded = expandHome(trimmed, options.home);
    const folder = yield* resolveFolder(listWhole ? expanded : dirname(expanded), options.home);
    const prefix = listWhole ? "" : basename(expanded);
    const limit = options.limit ?? FOLDER_LIMIT;

    const dirents = yield* Effect.tryPromise({
      try: () => readdir(folder, { withFileTypes: true }),
      catch: (error) => folderError(error, folder),
    });
    const lowered = prefix.toLowerCase();
    const matches = dirents
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => (name.startsWith(".") ? prefix.startsWith(".") : true))
      .filter((name) => name.toLowerCase().startsWith(lowered))
      .toSorted((a, b) => a.localeCompare(b));

    const parent = dirname(folder);
    const git = gitKind(folder);
    return {
      path: folder,
      ...(parent === folder ? {} : { parent }),
      ...(git === undefined ? {} : { git }),
      entries: matches.slice(0, limit).map((name) => {
        const path = join(folder, name);
        return { name, path, isGitRepo: existsSync(join(path, ".git")) };
      }),
      truncated: matches.length > limit,
    };
  });

/**
 * `input` as a project root: an existing folder holding a `.git` directory. A `.git` file is a
 * linked worktree's or a submodule's, whose project is the repository they belong to.
 */
export const repoFolder = (
  input: string,
  home?: string,
): Effect.Effect<string, NotFound | InvalidState> =>
  resolveFolder(input, home).pipe(
    Effect.flatMap((path) =>
      Effect.try({
        try: () => statSync(join(path, ".git"), { throwIfNoEntry: false }),
        catch: (error) => folderError(error, path),
      }).pipe(
        Effect.flatMap((git) =>
          git?.isDirectory() === true
            ? Effect.succeed(path)
            : Effect.fail(
                new InvalidState({
                  message:
                    git === undefined ? notARepositoryMessage(path) : linkedCheckoutMessage(path),
                }),
              ),
        ),
      ),
    ),
  );

/** `path` with every link resolved, or why it can't be read. */
const realFolder = (path: string) =>
  Effect.tryPromise({ try: () => realPath(path), catch: (error) => folderError(error, path) });

/**
 * `path` as a folder a change by chat may grant: refused unless it is already canonical (its real
 * path, no link anywhere in it), its own `.git` is a folder (not a linked worktree's or a
 * submodule's file), and git names it as the top folder of the repository there. An empty or
 * broken `.git` isn't one: git reads no repository there, or the one around it. What is approved
 * is this folder; what it holds can change, as it can for anyone who may write there.
 */
export const canonicalRepoFolder = (
  path: string,
): Effect.Effect<string, NotFound | InvalidState, Proc> =>
  Effect.gen(function* () {
    const real = yield* realFolder(path);
    if (real !== path) {
      return yield* new InvalidState({
        message: `${path} isn't a real folder path: use the real folder: ${real}`,
      });
    }
    const info = yield* Effect.tryPromise({
      try: () => stat(path),
      catch: (error) => folderError(error, path),
    });
    if (!info.isDirectory()) return yield* new InvalidState({ message: `Not a folder: ${path}` });
    const dotGit = join(path, ".git");
    const own = yield* Effect.tryPromise({
      try: () =>
        lstat(dotGit).catch((error: { code?: unknown }) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }),
      catch: (error) => folderError(error, dotGit),
    });
    if (own === undefined) return yield* new InvalidState({ message: notARepositoryMessage(path) });
    if (!own.isDirectory()) {
      return yield* new InvalidState({ message: linkedCheckoutMessage(path) });
    }
    // Nothing of Gram's own environment may point git elsewhere.
    const read = yield* runGit(path, ["rev-parse", "--show-toplevel"], {
      omitEnv: (name) => name.startsWith("GIT_"),
      timeoutMs: 15_000,
    }).pipe(
      Effect.mapError(
        () => new InvalidState({ message: `Gram couldn't run git to read ${path}.` }),
      ),
    );
    const top = read.stdout.trim();
    if (read.status !== 0 || top === "") {
      return yield* new InvalidState({
        message: `${path} isn't a git repository's top folder: git reads no repository there.`,
      });
    }
    if (top !== path) {
      return yield* new InvalidState({
        message: `${path} isn't a git repository's top folder: git reads it as part of ${top}.`,
      });
    }
    return path;
  });

/**
 * The project whose root is the repository at `input`, registered if Gram doesn't know it;
 * `created` when this call registered it.
 */
export const registerRepo = (
  store: Pick<ThreadStoreShape, "listProjects" | "registerProject">,
  input: string,
  home?: string,
): Effect.Effect<
  { readonly project: Project; readonly created: boolean },
  NotFound | InvalidState
> =>
  Effect.gen(function* () {
    const root = yield* repoFolder(input, home);
    // `projectRootKey`, as `repositoryCandidates` and the store compare: lexical, so a project's
    // stored spelling matches without the disk, and case-folded only on Windows.
    const key = projectRootKey(root);
    const known = (yield* store.listProjects).find(
      (project) => projectRootKey(project.root) === key,
    );
    if (known !== undefined) return { project: known, created: false };
    // The store decides `created` in one transaction, so a registration racing this one isn't ours.
    return yield* store.registerProject({ root, name: basename(root) || root, repoRoot: root });
  });

/**
 * The repositories directly in `folder`, by root: every subfolder that is a repository's top folder,
 * all of them, none deeper. Nothing for a folder that is missing or can't be listed.
 */
export const reposIn = (folder: string): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() =>
    readdir(folder, { withFileTypes: true }).catch(
      // A default folder that was moved or never made just has nothing in it to offer.
      () => [],
    ),
  ).pipe(
    Effect.map((dirents) =>
      dirents
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => join(folder, d.name))
        .filter((path) => gitKind(path) === "repository"),
    ),
  );

/**
 * What a new workspace can pick its repositories from: the known projects, then every repository in
 * `folders` that isn't one, each once, by `projectRootKey`. A project whose folder holds no `.git`
 * (a plain folder a thread was started in, such as the default folder itself) is left out, since
 * a worker can't make a worktree of it.
 */
export const repositoryCandidates = (
  projects: ReadonlyArray<Project>,
  folders: ReadonlyArray<string>,
): Effect.Effect<RepositoryCandidates> =>
  Effect.gen(function* () {
    const seen = new Set(projects.map((project) => projectRootKey(project.root)));
    const known = projects
      .filter((project) => gitKind(project.root) !== undefined)
      .map((project) => ({ name: project.name, root: project.root, projectId: project.id }));
    const found: Array<RepositoryCandidate> = [];
    for (const folder of folders) {
      for (const path of yield* reposIn(folder)) {
        const root = projectRoot(path);
        const key = projectRootKey(root);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ name: basename(root) || root, root });
      }
    }
    return {
      repos: [...known, ...found.toSorted((a, b) => a.name.localeCompare(b.name))],
    };
  });

/**
 * Which repository sits at `root`: its `.git` directory's device and inode. Another repository
 * moved into the same folder has another; `undefined` when there is none to read.
 */
export const repoIdentity = (root: string): Effect.Effect<string | undefined> =>
  Effect.sync(() => {
    try {
      const git = statSync(join(root, ".git"), { bigint: true, throwIfNoEntry: false });
      return git?.isDirectory() === true ? `${git.dev}:${git.ino}` : undefined;
    } catch {
      // Unreadable is no identity; the caller compares, and a mismatch refuses.
      return undefined;
    }
  });

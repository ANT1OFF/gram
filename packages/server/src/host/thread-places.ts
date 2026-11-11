// A machine's places for threads started from a profile (`host.threadPlaces.*`): a folder of the
// host's own for a thread that works in no repository, and a profile's files laid in a folder or
// in a worktree of the host's clones. Everything here runs on the machine itself.
import {
  InvalidState,
  PROFILE_FILES_MAX,
  PROFILE_FILES_MAX_BYTES,
  type ProfileFile,
  profilePathProblem,
  type ThreadId,
} from "@gram/contracts";
import { git, Proc, type ProcShape, realPath, relativeInside } from "@gram/git";
import * as Effect from "effect/Effect";
import { lstat, mkdir, rm, rmdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { excludeLaid, layProfileFiles } from "../thread-profiles/lay.ts";

/** The folder under the host's clones where threads that work in no repository get theirs. */
export const HOST_THREADS_DIR = ".threads";

export interface HostThreadPlaces {
  /** `threadId`'s own folder, made new with `files` in it; where it is. */
  readonly make: (
    threadId: ThreadId,
    files: ReadonlyArray<ProfileFile>,
  ) => Effect.Effect<{ readonly path: string }, InvalidState>;
  /** `files` laid in `checkout`, a worktree of the host's clones; which were written. */
  readonly lay: (
    checkout: string,
    files: ReadonlyArray<ProfileFile>,
  ) => Effect.Effect<{ readonly laid: ReadonlyArray<string> }, InvalidState>;
  /** `threadId`'s own folder deleted, when there is one. */
  readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const refuse = (message: string) => new InvalidState({ message });

/**
 * The files as the host takes them: checked here again, whatever the control plane checked, since
 * these are paths written on this machine. The same bounds a profile has.
 */
const checked = (files: ReadonlyArray<ProfileFile>): Effect.Effect<void, InvalidState> => {
  if (files.length > PROFILE_FILES_MAX)
    return Effect.fail(refuse(`A thread is given at most ${PROFILE_FILES_MAX} files.`));
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const problem = profilePathProblem(file.path);
    if (problem !== undefined) return Effect.fail(refuse(problem));
    const key = file.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) return Effect.fail(refuse("Two of the files share a path."));
    seen.add(key);
    bytes += Buffer.byteLength(file.content, "utf8");
  }
  return bytes > PROFILE_FILES_MAX_BYTES
    ? Effect.fail(
        refuse(`A thread's files hold at most ${PROFILE_FILES_MAX_BYTES} bytes together.`),
      )
    : Effect.void;
};

/**
 * The places under `clones`, the folder the host keeps its clones in (`hostRepos`). A thread's own
 * folder is `<clones>/.threads/<thread id>`: inside the one folder of the host's a session may
 * open in (`folderGate`), and under a name no clone is filed at.
 */
export const threadPlacesOnHost = (proc: ProcShape, clones: string): HostThreadPlaces => {
  const root = join(resolve(clones), HOST_THREADS_DIR);
  const folderOf = (threadId: ThreadId): Effect.Effect<string, InvalidState> =>
    SAFE_ID.test(threadId)
      ? Effect.succeed(join(root, threadId))
      : Effect.fail(refuse(`Not a thread id: ${threadId}`));

  return {
    make: (threadId, files) =>
      Effect.gen(function* () {
        yield* checked(files);
        const folder = yield* folderOf(threadId);
        const made = yield* Effect.tryPromise({
          try: async () => {
            await mkdir(root, { recursive: true, mode: 0o700 });
            // A link left where the threads' folders go would send them elsewhere.
            if (!(await lstat(root)).isDirectory()) return "linked" as const;
            // Not recursive: a folder already there is another start's, and is left alone.
            await mkdir(folder, { mode: 0o700 });
            const [real, base] = await Promise.all([realPath(folder), realPath(resolve(clones))]);
            if (real === join(base, HOST_THREADS_DIR, threadId)) return "made" as const;
            await rmdir(folder).catch(() => undefined);
            return "linked" as const;
          },
          catch: (cause) =>
            refuse(
              (cause as { code?: unknown } | null)?.code === "EEXIST"
                ? "This machine already has a folder for that thread."
                : "This machine couldn't make the thread's folder.",
            ),
        });
        if (made === "linked")
          return yield* refuse("This machine's folder for threads isn't a folder of its own.");
        yield* layProfileFiles(folder, files).pipe(
          Effect.tapError(() =>
            Effect.promise(() =>
              rm(folder, { recursive: true, force: true }).catch(() => undefined),
            ),
          ),
        );
        return { path: yield* Effect.promise(() => realPath(folder).catch(() => folder)) };
      }),
    lay: (checkout, files) =>
      Effect.gen(function* () {
        yield* checked(files);
        // Only a folder really inside the host's clones, however the path spells it: a worktree
        // the host made there. Never the clones folder itself, nor the threads' own folders.
        const inside = yield* Effect.tryPromise({
          try: async () => {
            const [real, base] = await Promise.all([realPath(checkout), realPath(resolve(clones))]);
            const below = relativeInside(base, real);
            // Not the clones folder, not the threads' own folders, and nowhere in a `.git`.
            if (below === undefined || below === "") return undefined;
            const names = below.split(sep);
            if (names[0] === HOST_THREADS_DIR) return undefined;
            if (names.some((name) => name.toLowerCase() === ".git")) return undefined;
            // A linked worktree's `.git` is a file; a clone's own folder, or any folder that is
            // no checkout at all, is not where a thread's files go.
            return (await lstat(join(real, ".git"))).isFile() ? real : undefined;
          },
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        // And git itself takes the folder for the top of that worktree.
        const top =
          inside === undefined
            ? undefined
            : yield* git(inside, ["rev-parse", "--show-toplevel"]).pipe(
                Effect.provideService(Proc, proc),
                Effect.map((out) => (out.status === 0 ? out.stdout.trim() : undefined)),
                Effect.orElseSucceed(() => undefined),
              );
        const same =
          inside !== undefined && top !== undefined
            ? yield* Effect.promise(() =>
                realPath(top).then(
                  (real) => real === inside,
                  () => false,
                ),
              )
            : false;
        if (inside === undefined || !same)
          return yield* refuse("Files are laid only in a worktree of this machine's clones.");
        const laid = yield* layProfileFiles(inside, files, { keepExisting: true });
        yield* excludeLaid(proc, inside, laid);
        return { laid };
      }),
    remove: (threadId) =>
      folderOf(threadId).pipe(
        Effect.flatMap((folder) =>
          Effect.promise(() => rm(folder, { recursive: true, force: true }).catch(() => undefined)),
        ),
        Effect.ignore,
      ),
  };
};

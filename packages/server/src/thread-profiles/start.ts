// Starting a thread from a profile (`thread.createFromProfile`): the profile is checked whole,
// its workplace made and its files laid there, and the thread created with what it keeps of the
// profile (`Thread.profile`), which every session it opens is then given again (`policy.ts`).
import {
  decodeThreadProfile,
  embeddingOn,
  InvalidState,
  type ModelRef,
  orchestrationMode,
  profileBindingOf,
  type ProfileFile,
  profileFilesOf,
  type Thread,
  ThreadId,
  type ThreadProfile,
  type AgentUnavailable,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";
import type { ProfileRepositories } from "./repositories.ts";

/** What a caller hears while the hosted features are off. */
export const PROFILES_OFF =
  "Starting a thread from a profile is one of the hosted features, which are off here.";

/** Where the folders of threads whose workplace is none or scratch are made, under the data folder. */
export const PROFILE_THREADS_DIR = "profile-threads";

/** The name of the project those threads are filed under. */
export const PROFILE_THREADS_PROJECT = "Profile threads";

/** What a caller hears where there is no git to clone with (a test layer without `Proc`). */
export const NO_REPOSITORIES_HERE =
  "A profile whose workplace is repositories can't be started here: this server has no git to clone them with.";

export interface ProfileStarterDeps {
  readonly store: Pick<ThreadStoreShape, "getSettings" | "listProfiles" | "ensureProject">;
  readonly runtimes: Pick<ThreadRuntimesShape, "create" | "close">;
  /** The server's data folder (`ServerConfig.dataDir`). */
  readonly dataDir: string;
  /** Clones and worktrees for a workplace of repositories; absent where there is no git. */
  readonly repositories?: ProfileRepositories | undefined;
}

const refuse = (message: string) => new InvalidState({ message });

/**
 * Writes `files` under `folder`, making it and what lies between, and says which it wrote. The
 * paths were checked (`profilePathProblem`). A new folder holds nothing to collide with; in a
 * repository's checkout (`keepExisting`) a file already there is left as it is, the repository's
 * own winning, and nothing is written through a link, so no file lands outside the folder.
 */
export const layProfileFiles = (
  folder: string,
  files: ReadonlyArray<ProfileFile>,
  options: { readonly keepExisting?: boolean } = {},
): Effect.Effect<ReadonlyArray<string>, InvalidState> =>
  Effect.gen(function* () {
    let at = "the thread's folder";
    const laid: Array<string> = [];
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(folder, { recursive: true });
        for (const file of files) {
          at = file.path;
          const names = file.path.split("/");
          let parent = folder;
          for (const name of names.slice(0, -1)) {
            parent = join(parent, name);
            const stat = await lstat(parent).catch(() => undefined);
            if (stat === undefined) await mkdir(parent);
            else if (!stat.isDirectory()) throw Object.assign(new Error("link"), { code: "ELINK" });
          }
          const path = join(parent, names.at(-1)!);
          if (options.keepExisting === true && (await lstat(path).catch(() => undefined))) continue;
          // `wx` never follows a link left at the name, nor replaces what is there.
          await writeFile(path, file.content, { encoding: "utf8", flag: "wx" });
          laid.push(file.path);
        }
      },
      // The file's own path and the error's code: never where the data folder is.
      catch: (cause) =>
        refuse(
          `The profile's files couldn't be written (${at}: ${
            (cause as { code?: unknown } | null)?.code ?? "failed"
          }).`,
        ),
    });
    return laid;
  });

/** The model a profile names, as a thread runs on it. */
const modelOf = (profile: ThreadProfile): ModelRef => ({
  agent: profile.agent,
  model: profile.model.model,
  ...(profile.model.effort === undefined ? {} : { variant: profile.model.effort }),
  ...(profile.model.gatewayProfile === undefined
    ? {}
    : { profileId: profile.model.gatewayProfile }),
});

export const makeProfileStarter = ({
  store,
  runtimes,
  dataDir,
  repositories,
}: ProfileStarterDeps) => {
  /**
   * The thread `value` describes, started. Refused before anything is made: with the hosted
   * features off, for a value that isn't a profile of this version, and for one naming a gateway
   * profile this Gram doesn't have.
   */
  const start = (value: unknown): Effect.Effect<Thread, InvalidState | AgentUnavailable> =>
    Effect.gen(function* () {
      const settings = yield* store.getSettings;
      if (!embeddingOn(settings)) return yield* refuse(PROFILES_OFF);
      const decoded = decodeThreadProfile(value);
      if (!decoded.ok) {
        return yield* refuse(`That profile can't be applied. ${decoded.problems.join(" ")}`);
      }
      const { profile } = decoded;
      const { workplace } = profile;
      if (workplace.kind === "repositories" && repositories === undefined) {
        return yield* refuse(NO_REPOSITORIES_HERE);
      }
      const gateway = profile.model.gatewayProfile;
      if (gateway !== undefined && !(yield* store.listProfiles).some((p) => p.id === gateway)) {
        return yield* refuse(
          `There is no gateway profile ${gateway} here for the model to run on.`,
        );
      }

      const id = Schema.decodeSync(ThreadId)(randomUUID());
      const files = profileFilesOf(profile);
      const base = {
        id,
        model: modelOf(profile),
        // It runs with nobody at the composer, as an orchestrator's worker does.
        mode: orchestrationMode(settings),
        ...(profile.name === undefined || profile.name.trim() === ""
          ? {}
          : // Its title until it gets one: not the user's own, so a later name may replace it.
            { title: profile.name.trim(), kept: { userNamed: false } }),
        ...(profile.input === undefined ? {} : { input: { text: profile.input } }),
        profile: profileBindingOf(profile),
      };

      if (workplace.kind === "repositories" && repositories !== undefined) {
        const place = yield* repositories.prepare(id, workplace.repositories);
        const checkouts = [place.checkout, ...place.extraCheckouts];
        const made = Effect.gen(function* () {
          const laid = yield* layProfileFiles(place.checkout.path, files, { keepExisting: true });
          yield* repositories.exclude(place.checkout.path, laid);
          return yield* runtimes.create({
            ...base,
            projectRoot: place.projectRoot,
            checkout: place.checkout,
            extraCheckouts: place.extraCheckouts,
            // The other repositories are the thread's to work in too, as a worker's are.
            additionalDirectories: place.extraCheckouts.map((extra) => extra.path),
          });
        });
        // A start that fails leaves nothing: the thread goes first, if it was stored, then the
        // worktrees made for it. The clones stay, for the next thread of the same repository.
        return yield* made.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : runtimes
                  .close(id)
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.forEach(checkouts, repositories.discard, { discard: true }),
                    ),
                  ),
          ),
        );
      }

      const root = join(dataDir, PROFILE_THREADS_DIR);
      const folder = join(root, id);
      const made = Effect.gen(function* () {
        yield* layProfileFiles(folder, files);
        // Named once here; `create` would otherwise name the project for its folder.
        yield* store.ensureProject({ root, name: PROFILE_THREADS_PROJECT });
        return yield* runtimes.create({
          ...base,
          projectRoot: root,
          checkout: { kind: "main", path: folder },
        });
      });
      // A start that fails, at whatever step, leaves nothing: a supplier that tries again would
      // otherwise pile up threads that never ran and folders nothing owns. The thread goes first,
      // if it got as far as being stored, then its folder.
      return yield* made.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : runtimes
                .close(id)
                .pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.promise(() =>
                      rm(folder, { recursive: true, force: true }).catch(() => undefined),
                    ),
                  ),
                ),
        ),
      );
    });

  return { start };
};

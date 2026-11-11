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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThreadStoreShape } from "../persistence/thread-store.ts";
import type { ThreadRuntimesShape } from "../runtime/thread-runtimes-shape.ts";

/** What a caller hears while the hosted features are off. */
export const PROFILES_OFF =
  "Starting a thread from a profile is one of the hosted features, which are off here.";

/** Where the folders of threads whose workplace is none or scratch are made, under the data folder. */
export const PROFILE_THREADS_DIR = "profile-threads";

/** The name of the project those threads are filed under. */
export const PROFILE_THREADS_PROJECT = "Profile threads";

export const REPOSITORIES_NOT_YET =
  "A profile whose workplace is repositories can't be started yet: this version makes a thread's own folder only.";

export interface ProfileStarterDeps {
  readonly store: Pick<ThreadStoreShape, "getSettings" | "listProfiles" | "ensureProject">;
  readonly runtimes: Pick<ThreadRuntimesShape, "create" | "close">;
  /** The server's data folder (`ServerConfig.dataDir`). */
  readonly dataDir: string;
}

const refuse = (message: string) => new InvalidState({ message });

/**
 * Writes `files` under `folder`, making it and what lies between. The paths were checked
 * (`profilePathProblem`) and the folder is new, so nothing written can land outside it.
 */
export const layProfileFiles = (
  folder: string,
  files: ReadonlyArray<ProfileFile>,
): Effect.Effect<void, InvalidState> =>
  Effect.gen(function* () {
    let at = "the thread's folder";
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(folder, { recursive: true });
        for (const file of files) {
          at = file.path;
          const path = join(folder, ...file.path.split("/"));
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, file.content, { encoding: "utf8", flag: "wx" });
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

export const makeProfileStarter = ({ store, runtimes, dataDir }: ProfileStarterDeps) => {
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
      if (profile.workplace.kind === "repositories") return yield* refuse(REPOSITORIES_NOT_YET);
      const gateway = profile.model.gatewayProfile;
      if (gateway !== undefined && !(yield* store.listProfiles).some((p) => p.id === gateway)) {
        return yield* refuse(
          `There is no gateway profile ${gateway} here for the model to run on.`,
        );
      }

      const id = Schema.decodeSync(ThreadId)(randomUUID());
      const root = join(dataDir, PROFILE_THREADS_DIR);
      const folder = join(root, id);
      const made = Effect.gen(function* () {
        yield* layProfileFiles(folder, profileFilesOf(profile));
        // Named once here; `create` would otherwise name the project for its folder.
        yield* store.ensureProject({ root, name: PROFILE_THREADS_PROJECT });
        return yield* runtimes.create({
          id,
          projectRoot: root,
          checkout: { kind: "main", path: folder },
          model: modelOf(profile),
          // It runs with nobody at the composer, as an orchestrator's worker does.
          mode: orchestrationMode(settings),
          ...(profile.name === undefined || profile.name.trim() === ""
            ? {}
            : // Its title until it gets one: not the user's own, so a later name may replace it.
              { title: profile.name.trim(), kept: { userNamed: false } }),
          ...(profile.input === undefined ? {} : { input: { text: profile.input } }),
          profile: profileBindingOf(profile),
        });
      });
      // A start that fails, at whatever step, leaves nothing: a supplier that tries again would
      // otherwise pile up threads that never ran and folders nothing owns. The thread goes first,
      // if it got as far as being stored (an agent that couldn't open), then its folder.
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

// The workspace an orchestrator started from a profile orchestrates (`ThreadProfile.role`): its
// charter, made from the profile, and the folder here it is filed under, which keeps the profile so
// that each worker spawned there is started with the same files, skills, MCP server and level.
import {
  DEFAULT_CHARTER,
  decodeThreadProfile,
  InvalidState,
  type ModelRef,
  type OrchestratorCharter,
  type ThreadProfile,
  type ThreadProfileBinding,
  profileBindingOf,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the folders of workspaces made for profiles' orchestrators are, under the data folder. */
export const PROFILE_HOMES_DIR = "profile-homes";

/** The profile kept in such a folder, for the workers spawned there. */
export const HOME_PROFILE_FILE = "profile.json";

/** What a start of an orchestrator hears where this server has no orchestration (a test layer). */
export const NO_ORCHESTRATION = "This server can't start orchestrators.";

/** The model a profile names, as a thread runs on it. */
export const modelOf = (profile: ThreadProfile): ModelRef => ({
  agent: profile.agent,
  model: profile.model.model,
  ...(profile.model.effort === undefined ? {} : { variant: profile.model.effort }),
  ...(profile.model.gatewayProfile === undefined
    ? {}
    : { profileId: profile.model.gatewayProfile }),
});

/**
 * The charter of the workspace `profile`'s orchestrator is started for: the profile's level, and
 * its model for the orchestrator and as the one model its workers run on, and the memory updates
 * it asks for. The rest is a new workspace's.
 */
export const homeCharter = (profile: ThreadProfile): OrchestratorCharter => {
  const after =
    profile.role?.kind === "orchestrator" ? profile.role.workspace.memoryUpdatesAfter : undefined;
  return {
    ...DEFAULT_CHARTER,
    autonomy: profile.autonomy ?? "publish",
    orchestratorModel: modelOf(profile),
    workerModels: [modelOf(profile)],
    ...(after === undefined ? {} : { automaticDreamThreshold: after }),
  };
};

/**
 * Keeps `profile` in `home`, the folder its workspace is filed under, without its first message,
 * which is the orchestrator's alone. Written again by a start asked for again: the same profile.
 */
export const writeHomeProfile = (
  home: string,
  profile: ThreadProfile,
): Effect.Effect<void, InvalidState> => {
  const { input: _input, ...kept } = profile;
  return Effect.tryPromise({
    try: async () => {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, HOME_PROFILE_FILE), `${JSON.stringify(kept)}\n`);
    },
    catch: (cause) =>
      new InvalidState({
        message: `The orchestrator's workspace couldn't be made: ${String(cause)}`,
      }),
  });
};

/** What a worker spawned in a profile's workspace starts with. */
export interface HomeWorker {
  /** The profile's files and skills, laid in the worker's own folder. */
  readonly profile: ThreadProfile;
  /**
   * What the worker keeps of the profile: its MCP server, level and source, and none of its
   * charter, which is the orchestrator's. The worker is told its work in its brief.
   */
  readonly binding: ThreadProfileBinding;
}

/** The profile kept in `home`, read as a worker starts; refused when it is gone or unreadable. */
export const readHomeProfile = (home: string): Effect.Effect<HomeWorker, InvalidState> =>
  Effect.gen(function* () {
    const text = yield* Effect.tryPromise({
      try: () => readFile(join(home, HOME_PROFILE_FILE), "utf8"),
      catch: () =>
        new InvalidState({ message: "This workspace's profile is gone, so no worker can start." }),
    });
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return yield* new InvalidState({ message: "This workspace's profile can't be read." });
    }
    const decoded = decodeThreadProfile(value);
    if (!decoded.ok)
      return yield* new InvalidState({
        message: `This workspace's profile can't be applied. ${decoded.problems.join(" ")}`,
      });
    const profile = decoded.profile;
    return { profile, binding: { ...profileBindingOf(profile), charter: "" } };
  });

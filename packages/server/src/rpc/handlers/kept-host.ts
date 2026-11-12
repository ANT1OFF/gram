// `app.keptHost` and `app.keptHostStop`: this machine's host kept running after Gram quits, as
// Settings shows it and stops it.

import { InvalidState, keepRunningAfterQuitOn, type KeptHostStatus } from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerConfig } from "../../config.ts";
import { LocalHostProcess } from "../../host/local-process.ts";
import {
  localServicePaths,
  localServicePlatform,
  stopLocalService,
} from "../../host/local-service-unit.ts";
import { ThreadStore } from "../../persistence/thread-store.ts";
import { KeptSessions } from "../../runtime/kept-sessions.ts";
import type { Handlers } from "./common.ts";

export const keptHostHandlers = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const store = yield* ThreadStore;
  // Absent in layers that run no host process or keep nothing.
  const local = Option.getOrUndefined(yield* Effect.serviceOption(LocalHostProcess));
  const kept = Option.getOrUndefined(yield* Effect.serviceOption(KeptSessions));
  const platform = localServicePlatform();
  const available = platform !== undefined && config.headless !== true;
  const paths = platform === undefined ? undefined : localServicePaths(config.dataDir, platform);

  const status: Effect.Effect<KeptHostStatus> = Effect.gen(function* () {
    const on = keepRunningAfterQuitOn(yield* store.getSettings);
    const running =
      local?.keptRunning === true && local.connection !== undefined && !local.connection.gone();
    return {
      available,
      on,
      running,
      ...(paths === undefined ? {} : { service: paths.name }),
      sessions: running && kept !== undefined ? kept.recorded() : 0,
      ...(local?.keptRunningProblem === undefined ? {} : { problem: local.keptRunningProblem }),
    };
  });

  return {
    "app.keptHost": () => status,
    "app.keptHostStop": () =>
      platform === undefined || paths === undefined || !available
        ? Effect.fail(new InvalidState({ message: "This machine keeps no host running." }))
        : stopLocalService(platform, paths, undefined, false).pipe(
            Effect.andThen(
              Effect.logInfo("kept host: stopped from Settings; its sessions ended with it"),
            ),
          ),
  } satisfies Partial<Handlers>;
});

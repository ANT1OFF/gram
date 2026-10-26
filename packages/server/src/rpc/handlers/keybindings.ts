import { existsSync } from "node:fs";
import { InvalidState } from "@gram/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import { ServerConfig } from "../../config.ts";
import { EventHub } from "../../events/event-hub.ts";
import {
  readKeybindings,
  watchKeybindings,
  writeKeybindings,
} from "../../keybindings/keybindings.ts";
import type { Handlers } from "./common.ts";

/** `keybindings.get` / `.set`, plus a `keybindings.changed` event whenever the file changes on disk. */
export const keybindingsHandlers = Effect.gen(function* () {
  const { dataDir } = yield* ServerConfig;
  const hub = yield* EventHub;
  const read = Effect.promise(() => readKeybindings(dataDir));

  if (existsSync(dataDir)) {
    const run = yield* FiberSet.makeRuntime();
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        watchKeybindings(dataDir, () => {
          run(
            read.pipe(
              Effect.flatMap((keybindings) =>
                hub.publish({ type: "keybindings.changed", keybindings }),
              ),
              Effect.onError((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.void
                  : Effect.logError("keybindings watcher failed", cause),
              ),
            ),
          );
        }),
      ),
      (stop) => Effect.sync(stop),
    );
  }

  return {
    "keybindings.get": () => read,
    "keybindings.set": ({ bindings }) =>
      Effect.tryPromise({
        try: () => writeKeybindings(dataDir, bindings),
        catch: (error) =>
          new InvalidState({
            message: `Couldn't write keybindings.json: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
  } satisfies Partial<Handlers>;
});

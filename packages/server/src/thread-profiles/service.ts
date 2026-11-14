// The one profile starter a server has, for the RPC (`thread.createFromProfile`) and the HTTP route
// a fronting platform's own service calls (`routes.ts`): one, so a start asked for twice under one
// id, by either way in, makes one thread.
import { Proc } from "@gram/git";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ServerConfig } from "../config.ts";
import { RemoteHosts } from "../host/remote-hosts.ts";
import { WorkerHosts } from "../host/worker-host.ts";
import { ThreadStore } from "../persistence/thread-store.ts";
import { makeThreadCreator } from "../runtime/create-in-checkout.ts";
import { CheckoutService } from "../runtime/hooks.ts";
import { ThreadRuntimes } from "../runtime/thread-runtimes.ts";
import { makeProfileRepositories } from "./repositories.ts";
import { makeProfileStarter, type ProfileStarter } from "./start.ts";

/** How often the threads waiting for a machine are looked at for one that waited too long. */
const WAITS_LOOK = "15 seconds";

/**
 * A starter over the services in scope. The machines are absent in runtime-only test layers,
 * where none is joined, and git is absent where there is none to clone with.
 */
export const profileStarterHere = Effect.gen(function* () {
  const store = yield* ThreadStore;
  const runtimes = yield* ThreadRuntimes;
  const checkouts = yield* CheckoutService;
  const config = yield* ServerConfig;
  const hosts = Option.getOrUndefined(yield* Effect.serviceOption(WorkerHosts));
  const remote = Option.getOrUndefined(yield* Effect.serviceOption(RemoteHosts));
  const proc = Option.getOrUndefined(yield* Effect.serviceOption(Proc));
  const creator = makeThreadCreator({ store, checkouts, runtimes });
  return makeProfileStarter({
    store,
    runtimes,
    dataDir: config.dataDir,
    hosts,
    ...(remote === undefined ? {} : { machines: { get: (id) => remote.machines.get(id) } }),
    repositories:
      proc === undefined
        ? undefined
        : makeProfileRepositories({
            proc,
            dataDir: config.dataDir,
            ensureProject: store.ensureProject,
            prepare: creator.prepare,
            discard: checkouts.discard,
          }),
  });
});

export class ProfileStarters extends Context.Service<ProfileStarters, ProfileStarter>()(
  "@gram/server/ProfileStarters",
) {
  static readonly layer: Layer.Layer<
    ProfileStarters,
    never,
    ThreadStore | ThreadRuntimes | CheckoutService | ServerConfig
  > = Layer.effect(
    ProfileStarters,
    Effect.gen(function* () {
      const starter = yield* profileStarterHere;
      // For the server's life: a thread that waited too long for its machine says none came. Read
      // from the store each time, so it holds across a restart with nothing to arm again.
      yield* Effect.forkScoped(
        starter.expireWaits.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("couldn't look for threads whose machine never came").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            ),
          ),
          Effect.andThen(Effect.sleep(WAITS_LOOK)),
          Effect.forever,
        ),
      );
      return starter;
    }),
  );
}

/** The server's starter where it has one, else one of its own (a test layer of the handlers). */
export const profileStarter = Effect.flatMap(Effect.serviceOption(ProfileStarters), (found) =>
  Option.isSome(found) ? Effect.succeed(found.value) : profileStarterHere,
);

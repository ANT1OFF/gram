import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { startMovingAsked } from "../embedding/signed-in-moves.ts";
import { SignedInWorkers } from "../embedding/signed-in-workers.ts";
import type { RemoteHostsShape } from "../host/remote-hosts.ts";
import { cancelStop, prepareStop, readyOnGoing, resumeOwedMachines } from "../host/stop-resume.ts";
import { startWipKeeper } from "../host/wip-keeper.ts";

/** What the joined machines' upkeep reads and changes. */
export type MachineUpkeepDeps = Parameters<typeof startWipKeeper>[0] &
  Parameters<typeof resumeOwedMachines>[0] & { readonly hosts: RemoteHostsShape };

/**
 * What looks after joined machines beside the routes, for as long as the scope lasts: their
 * threads' work kept while they work (`startWipKeeper`), a machine readied as its host says it goes
 * (`readyOnGoing`), the machines owed a resume resumed (`resumeOwedMachines`), and, in the desktop
 * app, the hosted worker machines their provider asks to move moved (`startMovingAsked`).
 */
export const startMachineUpkeep = (deps: MachineUpkeepDeps) =>
  Effect.gen(function* () {
    yield* startWipKeeper(deps);
    const off = deps.hosts.onGoing(readyOnGoing(deps));
    yield* Effect.addFinalizer(() => Effect.sync(off));
    yield* resumeOwedMachines(deps);
    const signedIn = Option.getOrUndefined(yield* Effect.serviceOption(SignedInWorkers));
    if (signedIn?.port.available !== true) return;
    yield* startMovingAsked({
      port: signedIn.port,
      machines: () => deps.hosts.list(),
      prepare: (id) => prepareStop(deps, id, { force: true }),
      readied: (id) => deps.hosts.stops.holding(id),
      takeBack: (id) => cancelStop(deps, id),
    });
  });

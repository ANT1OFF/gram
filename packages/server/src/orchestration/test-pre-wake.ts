import type { ThreadId } from "@gram/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MachinePreWake } from "../host/pre-wake.ts";

/** One ask for a thread's machine ahead of its work, and when it was made. */
export interface PreWakeAsk {
  readonly threadId: ThreadId;
  readonly until: number;
  readonly why: string;
  readonly at: number;
}

const asks = new WeakMap<object, Array<PreWakeAsk>>();

/** Every ask a server built over `world` made for a machine ahead of its work, in order. */
export const preWakesOf = (world: object): Array<PreWakeAsk> => {
  const known = asks.get(world);
  if (known !== undefined) return known;
  const made: Array<PreWakeAsk> = [];
  asks.set(world, made);
  return made;
};

/** A `MachinePreWake` that only records each ask in `preWakesOf(world)`. */
export const recordingPreWake = (world: object) =>
  Layer.succeed(MachinePreWake)({
    ahead: (threadId, until, why) =>
      Effect.map(Clock.currentTimeMillis, (at) => {
        preWakesOf(world).push({ threadId, until, why, at });
      }),
  });

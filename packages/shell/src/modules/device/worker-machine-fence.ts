// The app's fence between a stop and a start of one worker machine name on one server
// (`hosted-worker-machines.ts`). Every call about a worker machine goes out from here, so this is
// where a stop finally reaches the server: the one place a stop that waited (behind a token
// renewal, say) can still be told the name has moved on.
//
// - A start of a name, once the app has it, holds the name: a stop of it still waiting to go out
//   is dropped, never sent, since it was meant for the machine before.
// - A start goes out only once no stop of the name is on its way: not while one is sent and not
//   yet answered, nor for a while after one that got no answer, which the server may still act on.
// - A stop is not sent past its `sendBy`, however long it waited.

import { setTimeout } from "node:timers/promises";

/** How long a start waits after a stop of its name that got no answer, as the server may act on it. */
export const STOP_SETTLE_MS = 30_000;

/** Why a stop wasn't sent: the name was taken by a newer start meanwhile. */
export const SUPERSEDED =
  "A newer start of this machine's name came first, so the stop meant for the one before wasn't sent.";

/** Why a stop wasn't sent: it waited past the time it could go. */
export const STOP_TOO_LATE = "The stop waited past the time it could be sent, so it wasn't.";

interface NameState {
  /** Starts the app has had of the name: a stop that saw fewer is for an earlier machine. */
  starts: number;
  /** Stops of the name sent and not yet answered. */
  onWire: number;
  /** Until when a start waits, after a stop that got no answer. */
  quietUntil: number;
  /** Told as the last stop on the wire is over. */
  drained: Array<() => void>;
}

/** One call's place in the fence: run `gate` just before each request goes out, `done` after. */
export interface FencedCall {
  /** Why not to send it now, or nothing: it may go (a start may wait here first). */
  readonly gate: () => Promise<string | undefined>;
  /** The call is over: `answered`, whether the server's answer came back. */
  readonly done: (answered: boolean) => void;
}

export const makeWorkerMachineFence = (
  options: {
    readonly now?: () => number;
    readonly settleMs?: number;
  } = {},
) => {
  const now = options.now ?? Date.now;
  const names = new Map<string, NameState>();
  const stateOf = (origin: string, name: string) => {
    const key = JSON.stringify([origin, name]);
    let state = names.get(key);
    if (state === undefined) {
      state = { starts: 0, onWire: 0, quietUntil: 0, drained: [] };
      names.set(key, state);
    }
    return state;
  };
  return {
    /**
     * A call as the app receives it. A status or a release passes untouched; a start and a stop
     * are fenced against each other, by name.
     */
    enter: (
      origin: string,
      call: string,
      name: unknown,
      sendBy: number | undefined,
    ): FencedCall | undefined => {
      if (typeof name !== "string" || (call !== "start" && call !== "stop")) return undefined;
      const state = stateOf(origin, name);
      if (call === "start") {
        state.starts += 1;
        return {
          gate: async () => {
            for (;;) {
              if (state.onWire > 0) await new Promise<void>((done) => state.drained.push(done));
              else if (now() < state.quietUntil) await setTimeout(state.quietUntil - now());
              else return undefined;
            }
          },
          done: () => undefined,
        };
      }
      const seen = state.starts;
      let sent = false;
      return {
        gate: async () => {
          if (state.starts !== seen) return SUPERSEDED;
          if (sendBy !== undefined && now() > sendBy) return STOP_TOO_LATE;
          if (!sent) {
            sent = true;
            state.onWire += 1;
          }
          return undefined;
        },
        done: (answered) => {
          if (!sent) return;
          state.onWire -= 1;
          if (state.onWire === 0) for (const done of state.drained.splice(0)) done();
          if (!answered)
            state.quietUntil = Math.max(
              state.quietUntil,
              now() + (options.settleMs ?? STOP_SETTLE_MS),
            );
        },
      };
    },
  };
};

export type WorkerMachineFence = ReturnType<typeof makeWorkerMachineFence>;

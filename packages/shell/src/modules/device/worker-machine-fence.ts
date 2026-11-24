import { setTimeout } from "node:timers/promises";

/** How long a start waits after a stop of its name that got no answer, as the server may act on it. */
export const STOP_SETTLE_MS = 30_000;

/** Why a stop wasn't sent: the name was taken by a newer start meanwhile. */
export const SUPERSEDED =
  "A newer start of this machine's name came first, so the stop meant for the one before wasn't sent.";

/** Why a stop wasn't sent: it waited past the time it could go. */
export const STOP_TOO_LATE = "The stop waited past the time it could be sent, so it wasn't.";

interface NameState {
  starts: number;
  onWire: number;
  quietUntil: number;
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
     * are fenced against each other, by name. A move ends the run it names as a stop does (the
     * server starts the next one itself), so it is fenced as one.
     */
    enter: (
      origin: string,
      call: string,
      name: unknown,
      sendBy: number | undefined,
    ): FencedCall | undefined => {
      if (typeof name !== "string" || (call !== "start" && call !== "stop" && call !== "move"))
        return undefined;
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

/**
 * How much one hosted server may ask of a lent machine. The counts per thread use ids the server
 * chooses, so they only keep one thread from crowding out another; the counts per server are the
 * ones it can't dodge. One of these is made per server the app is signed in to.
 */

/** Asks waiting for an answer, the one on screen included. */
export const ASKS_WAITING_PER_THREAD = 3;
export const ASKS_WAITING_MOST = 8;
/** Requests a server may make in `ASK_WINDOW_MS`: asks, and requests refused for their path. */
export const ASKS_PER_WINDOW = 20;
export const ASK_WINDOW_MS = 10 * 60_000;
/** This many asks in a row refused or left unanswered pause lending to the server. */
export const REFUSALS_IN_A_ROW = 3;

export type AskOutcome =
  /** The person allowed it. */
  | "allowed"
  /** The person chose not to. */
  | "refused"
  /** Nobody answered in time. */
  | "unanswered"
  /** The server took it back, or lending stopped under it. Says nothing about the person. */
  | "withdrawn";

export interface AskLimits {
  /**
   * Whether a request may wait for the person's answer. When it may, it is counted, and
   * `settled` must be called once with how it ended.
   */
  readonly admit: (thread: string) => "ok" | "too-many-requests" | "paused";
  readonly settled: (thread: string, outcome: AskOutcome) => void;
  /**
   * Counts a request that was refused before any ask, for its path. These tell a server a little
   * about the disk each time, so they come out of the same allowance as asks.
   */
  readonly refusedUnasked: () => "ok" | "too-many-requests" | "paused";
  readonly paused: () => boolean;
  /** Lifts the pause. A decision: only a window the main process owns may call it. */
  readonly lift: () => void;
  readonly waiting: () => number;
}

export const makeAskLimits = (
  now: () => number,
  start: { readonly paused: boolean } = { paused: false },
  onPaused: () => void = () => undefined,
): AskLimits => {
  const waiting = new Map<string, number>();
  let recent: Array<number> = [];
  let inARow = 0;
  let paused = start.paused;
  const total = () => [...waiting.values()].reduce((sum, count) => sum + count, 0);
  const overRate = (): boolean => {
    const from = now() - ASK_WINDOW_MS;
    recent = recent.filter((time) => time > from);
    return recent.length >= ASKS_PER_WINDOW;
  };
  return {
    admit: (thread) => {
      if (paused) return "paused";
      if (overRate()) return "too-many-requests";
      const mine = waiting.get(thread) ?? 0;
      if (mine >= ASKS_WAITING_PER_THREAD || total() >= ASKS_WAITING_MOST)
        return "too-many-requests";
      waiting.set(thread, mine + 1);
      recent.push(now());
      return "ok";
    },
    settled: (thread, outcome) => {
      const mine = waiting.get(thread) ?? 0;
      if (mine <= 1) waiting.delete(thread);
      else waiting.set(thread, mine - 1);
      if (outcome === "allowed") inARow = 0;
      else if (outcome === "refused" || outcome === "unanswered") {
        inARow += 1;
        if (inARow >= REFUSALS_IN_A_ROW && !paused) {
          paused = true;
          onPaused();
        }
      }
    },
    refusedUnasked: () => {
      if (paused) return "paused";
      if (overRate()) return "too-many-requests";
      recent.push(now());
      return "ok";
    },
    paused: () => paused,
    lift: () => {
      paused = false;
      inARow = 0;
    },
    waiting: total,
  };
};

export type PowerState = "awake" | "suspended";

/** The slice of Electron's `powerMonitor` this needs. */
const POWER_EVENTS = ["suspend", "resume", "lock-screen", "unlock-screen"] as const;
type PowerEvent = (typeof POWER_EVENTS)[number];

export interface PowerEvents {
  on(event: PowerEvent, listener: () => void): void;
  off?(event: PowerEvent, listener: () => void): void;
}

/**
 * Reports `suspended` while the machine sleeps or the screen is locked, and `awake` again after.
 * Returns the unsubscribe. Locking counts as away: the user can't see a badge behind the lock
 * screen, and a locked laptop is the shape of an overnight run that spends the whole quota.
 */
export const watchPower = (
  monitor: PowerEvents,
  report: (state: PowerState) => void,
): (() => void) => {
  let asleep = false;
  let locked = false;
  let reported: PowerState | undefined;
  const publish = () => {
    const state: PowerState = asleep || locked ? "suspended" : "awake";
    if (state === reported) return;
    reported = state;
    report(state);
  };
  const handlers = {
    suspend: () => {
      asleep = true;
      publish();
    },
    resume: () => {
      asleep = false;
      publish();
    },
    "lock-screen": () => {
      locked = true;
      publish();
    },
    "unlock-screen": () => {
      locked = false;
      publish();
    },
  } satisfies Record<PowerEvent, () => void>;
  for (const event of POWER_EVENTS) monitor.on(event, handlers[event]);
  return () => {
    for (const event of POWER_EVENTS) monitor.off?.(event, handlers[event]);
  };
};

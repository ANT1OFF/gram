export type PowerState = "awake" | "suspended";

/** The slice of Electron's `powerMonitor` this needs. */
export interface PowerEvents {
  on(event: "suspend" | "resume" | "lock-screen" | "unlock-screen", listener: () => void): void;
  off?(event: "suspend" | "resume" | "lock-screen" | "unlock-screen", listener: () => void): void;
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
  } as const;
  for (const [event, handler] of Object.entries(handlers)) {
    monitor.on(event as keyof typeof handlers, handler);
  }
  return () => {
    for (const [event, handler] of Object.entries(handlers)) {
      monitor.off?.(event as keyof typeof handlers, handler);
    }
  };
};

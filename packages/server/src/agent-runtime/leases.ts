/**
 * Which installed versions have a process running from them. A leased version is never pruned or
 * replaced, so a Codex app-server that is mid-turn keeps the exact files it started from however
 * many updates or rollbacks happen meanwhile; the switch reaches the next app-server to start.
 */
export interface Leases {
  /** Holds `id` until the returned release runs (once; later calls do nothing). */
  readonly acquire: (id: string) => () => void;
  readonly count: (id: string) => number;
  readonly held: () => ReadonlySet<string>;
  /** Runs `listener` whenever a version's last lease is released. */
  readonly onIdle: (listener: (id: string) => void) => () => void;
}

export const makeLeases = (): Leases => {
  const counts = new Map<string, number>();
  const listeners = new Set<(id: string) => void>();
  return {
    acquire: (id) => {
      counts.set(id, (counts.get(id) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (counts.get(id) ?? 1) - 1;
        if (next > 0) {
          counts.set(id, next);
          return;
        }
        counts.delete(id);
        for (const listener of listeners) listener(id);
      };
    },
    count: (id) => counts.get(id) ?? 0,
    held: () => new Set(counts.keys()),
    onIdle: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

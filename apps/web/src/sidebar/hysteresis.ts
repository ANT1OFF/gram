import { createStore, type StoreApi } from "zustand/vanilla";

/** How long a move waits before it shows, so rows don't jitter. */
export const HYSTERESIS_MS = 750;

export interface StatusHold<K, V> {
  readonly store: StoreApi<{ shown: ReadonlyMap<K, V> }>;
  /** The statuses as they are now; what shows follows, at once or after the hold. */
  update(target: ReadonlyMap<K, V>): void;
  dispose(): void;
}

/**
 * The status each key is *shown* with: a key's first status, and a move `immediate` allows, show at once;
 * any other move waits `delayMs`, restarts if the target changes again, and is dropped if the key
 * moves back meanwhile.
 */
export function createStatusHold<K, V>(
  delayMs: number,
  immediate: (from: V, to: V) => boolean,
): StatusHold<K, V> {
  const store = createStore<{ shown: ReadonlyMap<K, V> }>()(() => ({ shown: new Map() }));
  const pending = new Map<K, { status: V; timer: ReturnType<typeof setTimeout> }>();
  const cancel = (key: K) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  return {
    store,
    update(target) {
      const shown = store.getState().shown;
      const next = new Map(shown);
      let changed = false;
      for (const [key, status] of target) {
        const current = shown.get(key);
        if (current === status) {
          cancel(key);
          continue;
        }
        if (current === undefined || immediate(current, status)) {
          cancel(key);
          next.set(key, status);
          changed = true;
          continue;
        }
        if (pending.get(key)?.status === status) continue;
        cancel(key);
        pending.set(key, {
          status,
          timer: setTimeout(() => {
            pending.delete(key);
            store.setState((s) => ({ shown: new Map(s.shown).set(key, status) }));
          }, delayMs),
        });
      }
      for (const key of shown.keys()) {
        if (!target.has(key)) {
          cancel(key);
          next.delete(key);
          changed = true;
        }
      }
      if (changed) store.setState({ shown: next });
    },
    dispose() {
      for (const key of pending.keys()) cancel(key);
    },
  };
}

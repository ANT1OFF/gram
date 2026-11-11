import type { VaultCrypto, VaultStore } from "../key-vault/vault.ts";
import { keyringBackendOk } from "@gram/contracts";
import type { DeviceSecrets, Presence } from "./hosted-device.ts";

/**
 * Whether the person is at the machine, as the operating system tells it: not asleep, not locked,
 * the session still theirs, and not idle for five minutes. Lock events don't arrive on every
 * system, so the idle state is also read on a timer, and `locked` there counts too. Where neither
 * can be had, presence isn't known and lending is unavailable.
 */

export type PresenceEvent =
  | "suspend"
  | "resume"
  | "lock-screen"
  | "unlock-screen"
  | "user-did-resign-active"
  | "user-did-become-active";

/** The slice of Electron's `powerMonitor` this reads. */
export interface PresenceMonitor {
  on(event: PresenceEvent, listener: () => void): void;
  off(event: PresenceEvent, listener: () => void): void;
  getSystemIdleState(idleThresholdSeconds: number): "active" | "idle" | "locked" | "unknown";
}

/** Idle this long is away. */
export const PRESENCE_IDLE_SECONDS = 5 * 60;
/** How often the idle state is read. */
export const PRESENCE_POLL_MS = 5_000;

export interface WatchedPresence extends Presence {
  readonly stop: () => void;
}

export const watchPresence = (
  monitor: PresenceMonitor,
  timers: {
    readonly every: (ms: number, tick: () => void) => () => void;
  } = {
    every: (ms, tick) => {
      const timer = setInterval(tick, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  },
): WatchedPresence => {
  let asleep = false;
  let locked = false;
  let resigned = false;
  let idle = monitor.getSystemIdleState(PRESENCE_IDLE_SECONDS);
  const known = idle !== "unknown";
  const listeners = new Set<() => void>();
  const present = () => !asleep && !locked && !resigned && idle === "active";
  let was = present();
  const publish = () => {
    const now = present();
    if (now === was) return;
    was = now;
    for (const listener of listeners) listener();
  };
  const handlers: Record<PresenceEvent, () => void> = {
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
    "user-did-resign-active": () => {
      resigned = true;
      publish();
    },
    "user-did-become-active": () => {
      resigned = false;
      publish();
    },
  };
  for (const [event, handler] of Object.entries(handlers))
    monitor.on(event as PresenceEvent, handler);
  const stopPolling = timers.every(PRESENCE_POLL_MS, () => {
    idle = monitor.getSystemIdleState(PRESENCE_IDLE_SECONDS);
    publish();
  });
  return {
    present: () => known && present(),
    known: () => known,
    onChange: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    stop: () => {
      stopPolling();
      for (const [event, handler] of Object.entries(handlers))
        monitor.off(event as PresenceEvent, handler);
      listeners.clear();
    },
  };
};

/**
 * The device's secrets in the operating system's keychain, through `safeStorage`: encrypted, in a
 * file of their own. Strong only with a real keyring: on Linux without one, `safeStorage` would
 * keep them under a fixed password, so nothing is kept and lending is unavailable. Made once the
 * app is ready, as `safeStorage` can't tell its backend before.
 */
export const vaultSecrets = (crypto: VaultCrypto, store: VaultStore): DeviceSecrets => {
  /** Strong once found so; a weak answer is asked again, as Linux's keyring may come up later. */
  let strong = false;
  const isStrong = async () => {
    if (!strong) {
      const available = (await crypto.available()) === true;
      const backend = crypto.backend?.();
      strong = available && (process.platform !== "linux" || keyringBackendOk(backend));
    }
    return strong;
  };
  /** Writes go one at a time, each reading what the last one wrote. */
  let queue: Promise<unknown> = Promise.resolve();
  const change = (apply: (entries: Record<string, string>) => Promise<void>) => {
    const next = queue
      .catch(() => undefined)
      .then(async () => {
        const entries = await store.read();
        await apply(entries);
        await store.write(entries);
      });
    queue = next;
    return next;
  };
  return {
    strong: isStrong,
    get: async (name) => {
      if (!(await isStrong())) return undefined;
      await queue.catch(() => undefined);
      const sealed = (await store.read())[name];
      return sealed === undefined ? undefined : await crypto.decrypt(Buffer.from(sealed, "base64"));
    },
    set: async (name, value) => {
      if (!(await isStrong())) throw new Error("No keyring: nothing is kept.");
      await change(async (entries) => {
        entries[name] = (await crypto.encrypt(value)).toString("base64");
      });
    },
    remove: async (name) => {
      await change(async (entries) => {
        delete entries[name];
      });
    },
  };
};

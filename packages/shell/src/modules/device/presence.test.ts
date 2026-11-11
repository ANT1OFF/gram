import { describe, expect, it } from "vitest";
import {
  type PresenceEvent,
  type PresenceMonitor,
  vaultSecrets,
  watchPresence,
} from "./presence.ts";

const fakeMonitor = (idle: "active" | "idle" | "locked" | "unknown" = "active") => {
  const listeners = new Map<PresenceEvent, Set<() => void>>();
  const state = { idle };
  const monitor: PresenceMonitor = {
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => listeners.get(event)?.delete(listener),
    getSystemIdleState: () => state.idle,
  };
  const emit = (event: PresenceEvent) => {
    for (const listener of listeners.get(event) ?? []) listener();
  };
  const count = () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  return { monitor, emit, state, count };
};

const manualTimer = () => {
  let tick: (() => void) | undefined;
  return {
    timers: {
      every: (_ms: number, next: () => void) => {
        tick = next;
        return () => {
          tick = undefined;
        };
      },
    },
    tick: () => tick?.(),
    running: () => tick !== undefined,
  };
};

describe("whether the person is at the machine", () => {
  it("is away while asleep, locked, switched out or idle, and back after each", () => {
    const { monitor, emit, state, count } = fakeMonitor();
    const timer = manualTimer();
    const presence = watchPresence(monitor, timer.timers);
    let changes = 0;
    presence.onChange(() => {
      changes += 1;
    });
    expect(presence.known()).toBe(true);
    expect(presence.present()).toBe(true);
    for (const [away, back] of [
      ["suspend", "resume"],
      ["lock-screen", "unlock-screen"],
      ["user-did-resign-active", "user-did-become-active"],
    ] as const) {
      emit(away);
      expect(presence.present(), away).toBe(false);
      emit(back);
      expect(presence.present(), back).toBe(true);
    }
    expect(changes).toBe(6);
    // Idle, or locked as only the idle state tells it.
    for (const idle of ["idle", "locked"] as const) {
      state.idle = idle;
      timer.tick();
      expect(presence.present(), idle).toBe(false);
      state.idle = "active";
      timer.tick();
      expect(presence.present()).toBe(true);
    }
    presence.stop();
    expect(count()).toBe(0);
    expect(timer.running()).toBe(false);
  });

  it("isn't known, and never present, where the system can't tell idle or locked", () => {
    const presence = watchPresence(fakeMonitor("unknown").monitor, manualTimer().timers);
    expect(presence.known()).toBe(false);
    expect(presence.present()).toBe(false);
  });
});

const memoryStore = () => {
  let entries: Record<string, string> = {};
  return {
    read: async () => ({ ...entries }),
    write: async (next: Record<string, string>) => {
      entries = { ...next };
    },
    raw: () => entries,
  };
};
const crypto = (available: boolean, backend?: string) => ({
  available: () => available,
  backend: () => backend,
  encrypt: (text: string) => Buffer.from(`sealed:${text}`),
  decrypt: (sealed: Buffer) => sealed.toString().replace(/^sealed:/, ""),
});

describe("the device's secrets", () => {
  it("keeps them sealed, and gets back what was set", async () => {
    const store = memoryStore();
    const secrets = vaultSecrets(
      crypto(true, process.platform === "linux" ? "gnome_libsecret" : undefined),
      store,
    );
    expect(secrets.strong()).toBe(true);
    await Promise.all([secrets.set("a", "one"), secrets.set("b", "two")]);
    expect(await secrets.get("a")).toBe("one");
    expect(await secrets.get("b")).toBe("two");
    expect(Object.values(store.raw()).join()).not.toContain("one");
    await secrets.remove("a");
    expect(await secrets.get("a")).toBeUndefined();
  });

  it("keeps nothing without a real keyring", async () => {
    const secrets = vaultSecrets(crypto(false), memoryStore());
    expect(secrets.strong()).toBe(false);
    await expect(secrets.set("a", "one")).rejects.toThrow();
    expect(await secrets.get("a")).toBeUndefined();
    if (process.platform === "linux")
      expect(vaultSecrets(crypto(true, "basic_text"), memoryStore()).strong()).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { watchPower, type PowerEvents, type PowerState } from "./power.ts";

const fakeMonitor = () => {
  const listeners = new Map<string, Set<() => void>>();
  const monitor: PowerEvents = {
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => void listeners.get(event)?.delete(listener),
  };
  return {
    monitor,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    count: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
};

describe("watchPower", () => {
  it("reports each transition once, and stays suspended while either cause holds", () => {
    const reported: PowerState[] = [];
    const fake = fakeMonitor();
    const stop = watchPower(fake.monitor, (state) => void reported.push(state));

    fake.emit("lock-screen");
    fake.emit("suspend");
    expect(reported).toEqual(["suspended"]);

    // Waking with the screen still locked is not yet "someone is looking".
    fake.emit("resume");
    expect(reported).toEqual(["suspended"]);
    fake.emit("unlock-screen");
    expect(reported).toEqual(["suspended", "awake"]);

    stop();
    expect(fake.count()).toBe(0);
    fake.emit("suspend");
    expect(reported).toEqual(["suspended", "awake"]);
  });
});

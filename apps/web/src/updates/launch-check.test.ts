import type { ReleaseInfo, UpdateCheck } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { decideUpdateNotice, pinForInstall, startUpdateWatch } from "./launch-check";

const AVAILABLE: UpdateCheck = {
  available: true,
  currentVersion: "1.0.0",
  canSelfInstall: true,
  channel: "stable",
  latestVersion: "1.2.0",
  tag: "v1.2.0",
};

const RELEASES: ReleaseInfo[] = [
  { tag: "v1.2.0", version: "1.2.0", prerelease: false, relation: "newer" },
  { tag: "v1.1.0", version: "1.1.0", prerelease: false, relation: "newer" },
  { tag: "v1.0.0", version: "1.0.0", prerelease: false, relation: "current" },
];

describe("decideUpdateNotice", () => {
  it("announces a newer release", () => {
    expect(decideUpdateNotice(AVAILABLE, undefined)).toEqual({
      announce: { version: "1.2.0", tag: "v1.2.0" },
      clearPin: false,
    });
  });

  it("stays quiet when up to date or when the check was unavailable", () => {
    const upToDate: UpdateCheck = {
      available: false,
      currentVersion: "1.0.0",
      canSelfInstall: true,
    };
    expect(decideUpdateNotice(upToDate, undefined)).toEqual({ clearPin: false });
    expect(decideUpdateNotice({ ...upToDate, unavailable: true }, "0.9.0")).toEqual({
      clearPin: false,
    });
  });

  it("stays quiet while the running version is the pinned one", () => {
    expect(decideUpdateNotice(AVAILABLE, "1.0.0")).toEqual({ clearPin: false });
  });

  it("clears a stale pin and announces", () => {
    expect(decideUpdateNotice(AVAILABLE, "0.9.0")).toEqual({
      announce: { version: "1.2.0", tag: "v1.2.0" },
      clearPin: true,
    });
  });
});

describe("pinForInstall", () => {
  it("pins anything but the channel's newest release", () => {
    expect(pinForInstall(RELEASES, "v1.2.0")).toBeNull();
    expect(pinForInstall(RELEASES, "v1.1.0")).toBe("1.1.0");
    expect(pinForInstall(RELEASES, "v0.1.0")).toBeNull();
  });
});

/** A manual timer queue standing in for the clock. */
function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    setTimer: (callback: () => void, ms: number) => {
      pending.set(++next, { callback, ms });
      return next;
    },
    clearTimer: (timer: unknown) => pending.delete(timer as number),
    fire() {
      const [id, entry] = [...pending][0]!;
      pending.delete(id);
      entry.callback();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("startUpdateWatch", () => {
  it("checks at once, then again after each interval, until stopped", async () => {
    const timers = fakeTimers();
    const feed: Array<UpdateCheck | Error> = [AVAILABLE, new Error("offline"), AVAILABLE];
    let calls = 0;
    const results: UpdateCheck[] = [];
    const stop = startUpdateWatch({
      check: async () => {
        const item = feed[calls++]!;
        if (item instanceof Error) throw item;
        return item;
      },
      onResult: (check) => results.push(check),
      intervalMs: 1000,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await settle();
    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([1000]);

    timers.fire();
    await settle();
    expect(calls).toBe(2);
    expect(results).toHaveLength(1);
    expect(timers.pending.size).toBe(1);

    stop();
    expect(timers.pending.size).toBe(0);
  });

  it("drops a result that settles after stop", async () => {
    const timers = fakeTimers();
    let resolve: ((check: UpdateCheck) => void) | undefined;
    const results: UpdateCheck[] = [];
    const stop = startUpdateWatch({
      check: () => new Promise((r) => (resolve = r)),
      onResult: (check) => results.push(check),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    stop();
    resolve?.(AVAILABLE);
    await settle();
    expect(results).toHaveLength(0);
    expect(timers.pending.size).toBe(0);
  });
});

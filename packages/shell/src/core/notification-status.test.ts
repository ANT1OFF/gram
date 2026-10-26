import type { NotificationStatus } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { createNotificationStatus, type WatchedNotification } from "./notification-status.ts";

/** An Electron notification as far as the tracker listens, with its OS events played by hand. */
const fakeNote = () => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const note: WatchedNotification = {
    on: (event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, [
        ...(listeners.get(event) ?? []),
        listener as (...args: unknown[]) => void,
      ]);
      return note;
    },
  };
  return {
    note,
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
};

const tracker = () => {
  let now = 1_000;
  const changes: NotificationStatus[] = [];
  const status = createNotificationStatus({
    supported: true,
    now: () => now,
    onChange: (next) => changes.push(next),
  });
  return { status, changes, tick: () => (now += 1_000) };
};

describe("createNotificationStatus", () => {
  it("knows nothing before the first notification", () => {
    expect(tracker().status.status()).toEqual({ supported: true, last: null });
  });

  it("follows a test from sent to accepted to clicked", () => {
    const { status, changes, tick } = tracker();
    const { note, emit } = fakeNote();
    status.watch(note, true);
    expect(status.status().last).toEqual({ outcome: "sent", at: 1_000, test: true });
    tick();
    emit("show");
    expect(status.status().last).toEqual({ outcome: "shown", at: 2_000, test: true });
    tick();
    emit("click");
    expect(status.status().last).toEqual({ outcome: "clicked", at: 3_000, test: true });
    // Shown again afterwards, as macOS may, isn't a step back.
    emit("show");
    expect(status.status().last?.outcome).toBe("clicked");
    expect(changes.map((change) => change.last?.outcome)).toEqual(["sent", "shown", "clicked"]);
  });

  it("reports the OS's refusal with its error", () => {
    const { status } = tracker();
    const { note, emit } = fakeNote();
    status.watch(note);
    emit("failed", {}, "Notifications are not allowed for this application");
    expect(status.status().last).toEqual({
      outcome: "failed",
      at: 1_000,
      test: false,
      error: "Notifications are not allowed for this application",
    });
  });

  it("counts an answer button as a click", () => {
    const { status } = tracker();
    const { note, emit } = fakeNote();
    status.watch(note);
    emit("action");
    expect(status.status().last?.outcome).toBe("clicked");
  });

  it("keeps an older notification's late answer from misreporting the newest", () => {
    const { status, tick } = tracker();
    const older = fakeNote();
    const newer = fakeNote();
    status.watch(older.note);
    tick();
    status.watch(newer.note, true);
    older.emit("show");
    expect(status.status().last).toEqual({ outcome: "sent", at: 2_000, test: true });
    newer.emit("failed", {}, "denied");
    older.emit("failed", {}, "other");
    expect(status.status().last?.error).toBe("denied");
    // A click on the older one still shows notifications reach the user.
    older.emit("click");
    expect(status.status().last?.outcome).toBe("clicked");
  });

  it("says when the system has no notifications", () => {
    const status = createNotificationStatus({ supported: false, now: () => 0, onChange: () => {} });
    expect(status.status()).toEqual({ supported: false, last: null });
  });
});

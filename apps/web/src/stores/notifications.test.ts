// @vitest-environment happy-dom
import type { ThreadId } from "@gram/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createNotificationHistory,
  DIAGNOSTIC_COOLDOWN_MS,
  HISTORY_LIMIT,
  NOTIFICATIONS_KEY,
  RETENTION_MS,
  restoreNotifications,
  unreadNotifications,
  useNotificationHistory,
} from "./notifications";
import { useThreadsStore } from "./threads";

const key = "a".repeat(64);
const warning = (id = "worker-1", diagnosticKey = key) => ({
  type: "notify" as const,
  kind: "info" as const,
  title: "MCP server sample didn't start: sign in required",
  threadId: id as ThreadId,
  startupDiagnostic: { key: diagnosticKey, source: "Codex MCP startup" },
});
beforeEach(() => {
  localStorage.clear();
  useNotificationHistory.setState({ entries: [], quiet: {} });
  useThreadsStore.setState({ notifications: [] });
});

describe("notification retention and startup quieting", () => {
  it("shows the first notice across newly spawned workers, counts repeats and retains source associations", () => {
    const { applyEvent } = useThreadsStore.getState();
    for (let i = 1; i <= 4; i++) applyEvent(warning(`worker-${i}`));
    expect(useThreadsStore.getState().notifications).toHaveLength(1);
    expect(useNotificationHistory.getState().entries).toMatchObject([
      {
        count: 4,
        source: "Codex MCP startup",
        threadIds: ["worker-1", "worker-2", "worker-3", "worker-4"],
      },
    ]);
    expect(unreadNotifications(useNotificationHistory.getState())).toBe(1);
    applyEvent(warning("new-source", "b".repeat(64)));
    applyEvent({ type: "notify", kind: "info", title: warning().title });
    expect(useThreadsStore.getState().notifications).toHaveLength(3);
  });

  it("never throttles errors, input requests or turn outcomes even with diagnostic metadata", () => {
    const { applyEvent } = useThreadsStore.getState();
    applyEvent(warning());
    for (const kind of ["error", "needsInput", "done"] as const) {
      applyEvent({ ...warning(), kind });
      applyEvent({ ...warning(), kind });
    }
    expect(useThreadsStore.getState().notifications).toHaveLength(7);
    expect(useNotificationHistory.getState().entries).toHaveLength(7);
  });

  it("read and clear survive reload without resetting the independent warning cooldown", () => {
    const store = createNotificationHistory(() => localStorage);
    const at = Date.now();
    expect(store.getState().record(warning(), at)).toBe(true);
    store.getState().markRead();
    expect(store.getState().record(warning("worker-2"), at + 100)).toBe(false);
    expect(unreadNotifications(store.getState())).toBe(0);
    // Clock matches the stored lastSeen when restoring.
    vi.spyOn(Date, "now").mockReturnValue(at + 200);
    const reopened = createNotificationHistory(() => localStorage);
    expect(reopened.getState().entries[0]).toMatchObject({ count: 2, read: true, firstSeen: at });
    reopened.getState().clear();
    const cleared = createNotificationHistory(() => localStorage);
    expect(cleared.getState().entries).toEqual([]);
    expect(cleared.getState().record(warning("worker-3"), at + 300)).toBe(false);
    expect(cleared.getState().record(warning("worker-4"), at + DIAGNOSTIC_COOLDOWN_MS)).toBe(true);
    expect(unreadNotifications(cleared.getState())).toBe(1);
    vi.restoreAllMocks();
  });

  it("caps history and associations, expires old data, and saves only bounded redacted user-facing fields", () => {
    const store = createNotificationHistory(() => localStorage);
    const at = Date.now();
    for (let i = 0; i < 120; i++)
      store.getState().record({ type: "notify", kind: "done", title: `Turn ${i}` }, at);
    expect(store.getState().entries).toHaveLength(HISTORY_LIMIT);
    expect(createNotificationHistory(() => localStorage).getState().entries).toHaveLength(
      HISTORY_LIMIT,
    );
    for (let i = 0; i < 12; i++) store.getState().record(warning(`worker-${i}`), at);
    expect(store.getState().entries[0]?.threadIds).toHaveLength(8);
    store.getState().record(
      {
        type: "notify",
        kind: "error",
        title: "token=secret-value",
        body: "https://user:password@example.com/path?anything=private#secret " + "x".repeat(4000),
      },
      at,
    );
    const retained = localStorage.getItem(NOTIFICATIONS_KEY)!;
    expect(retained).not.toContain("secret-value");
    expect(retained).not.toContain("user:password");
    expect(retained).not.toContain("anything=private");
    expect(store.getState().entries[0]?.body?.length).toBeLessThanOrEqual(2000);
    expect(restoreNotifications(retained, at + RETENTION_MS + 1).entries).toEqual([]);
  });

  it("recovers from corrupt, wrong-version, oversized, invalid and quota-disabled persistence", () => {
    const at = Date.now();
    for (const raw of [
      "not JSON",
      '{"version":2}',
      '"string"',
      "x".repeat(512_001),
      '{"version":1,"entries":[null,{"kind":"error"}],"quiet":{"bad":12}}',
    ]) {
      expect(restoreNotifications(raw, at)).toEqual({ entries: [], quiet: {} });
    }
    const inaccessible = createNotificationHistory(() => {
      throw new Error("Storage denied");
    });
    expect(inaccessible.getState().record(warning(), at)).toBe(true);
    expect(inaccessible.getState().record(warning("worker-2"), at)).toBe(false);
    const quota = createNotificationHistory(
      () =>
        ({
          getItem: () => null,
          setItem: () => {
            throw new Error("Quota");
          },
        }) as unknown as Storage,
    );
    expect(() => quota.getState().record(warning(), at)).not.toThrow();
    expect(quota.getState().entries).toHaveLength(1);
    expect(quota.getState().storageUnavailable).toBe(true);
  });
});

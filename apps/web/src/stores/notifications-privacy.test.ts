// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  createNotificationHistory,
  NOTIFICATIONS_KEY,
  restoreNotifications,
  unreadNotifications,
} from "./notifications";

const key = "a".repeat(64);
const notice = {
  type: "notify" as const,
  kind: "info" as const,
  title: "MCP server sample didn't start: sign in required",
  startupDiagnostic: { key, source: "Codex MCP startup" },
};
const omitted = "Sensitive notification details omitted";
const sensitiveFields = [
  "Cookie: session=invented-cookie; other=invented-other-cookie",
  "Set-Cookie: session=invented-cookie; HttpOnly; Secure",
  "Authorization: invented-arbitrary-auth with a multiline\ncontinuation",
  'Proxy-Authorization: Digest realm="invented-realm", nonce="invented-nonce"',
  '"authorization": { "customScheme": "invented-auth" }',
  'private_key="invented-private-key with whitespace"',
  '"privateKey": { "value": "invented-nested-key" }',
  "private key: invented-key\nwith continuation",
  ["-----BEGIN", "RSA PRIVATE KEY-----\ninvented-key-material\n-----END RSA PRIVATE KEY-----"].join(
    " ",
  ),
  'http_headers={"X-Unusual": "invented-header-value"}',
];
beforeEach(() => localStorage.clear());

describe("notification history privacy", () => {
  it.each(sensitiveFields)("omits an entire sensitive field on write and reload: %s", (field) => {
    const store = createNotificationHistory(() => localStorage);
    const event = {
      ...notice,
      title: `MCP startup failed: ${field}`,
      body: field,
      startupDiagnostic: { key, source: field },
    };
    expect(store.getState().record(event)).toBe(true);
    store.getState().markRead();
    expect(store.getState().record(event)).toBe(false);
    const entry = store.getState().entries[0];
    expect(entry).toMatchObject({
      title: omitted,
      body: omitted,
      source: omitted,
      diagnosticKey: key,
      count: 2,
      read: true,
    });
    const persisted = JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY)!) as {
      entries: unknown[];
    };
    expect(persisted.entries).toEqual([entry]);
    expect(localStorage.getItem(NOTIFICATIONS_KEY)).not.toContain("invented-");
    const reopened = createNotificationHistory(() => localStorage);
    expect(reopened.getState().entries).toEqual([entry]);
    expect(reopened.getState().record(event)).toBe(false);
    expect(unreadNotifications(reopened.getState())).toBe(0);
  });

  it("sanitizes every restored text field and immediately rewrites an unsafe cache without changing history or cooldown", () => {
    const at = Date.now();
    const seed = createNotificationHistory(() => localStorage);
    seed.getState().record(notice, at);
    const entry = {
      ...seed.getState().entries[0]!,
      title: "Cookie: session=invented-cookie",
      body: "Authorization: invented-auth",
      source: "private_key=invented-key",
      count: 8,
      read: true,
      firstSeen: at - 100,
    };
    const raw = JSON.stringify({ version: 1, entries: [entry], quiet: { [key]: at } });
    localStorage.setItem(NOTIFICATIONS_KEY, raw);
    const safe = { ...entry, title: omitted, body: omitted, source: omitted };
    expect(restoreNotifications(raw, at).entries).toEqual([safe]);
    const reopened = createNotificationHistory(() => localStorage);
    expect(reopened.getState().entries).toEqual([safe]);
    expect(reopened.getState().quiet).toEqual({ [key]: at });
    expect(localStorage.getItem(NOTIFICATIONS_KEY)).not.toContain("invented-");
    expect(reopened.getState().record(notice, at)).toBe(false);
    expect(reopened.getState().entries[0]).toMatchObject({
      count: 9,
      read: true,
      firstSeen: at - 100,
    });
    reopened.getState().clear();
    const cleared = createNotificationHistory(() => localStorage);
    expect(cleared.getState().entries).toEqual([]);
    expect(cleared.getState().record(notice, at)).toBe(false);
  });

  it("keeps sanitized restored history and cooldown in memory when the cache rewrite is refused", () => {
    const at = Date.now();
    const seed = createNotificationHistory(() => localStorage);
    seed.getState().record(notice, at);
    const entry = {
      ...seed.getState().entries[0]!,
      title: "Cookie: session=invented-cookie",
      read: true,
    };
    const raw = JSON.stringify({ version: 1, entries: [entry], quiet: { [key]: at } });
    const reopened = createNotificationHistory(
      () =>
        ({
          getItem: () => raw,
          setItem: () => {
            throw new Error("Owned synthetic quota refusal");
          },
        }) as unknown as Storage,
    );
    expect(reopened.getState().entries[0]).toMatchObject({ title: omitted, read: true });
    expect(reopened.getState().storageUnavailable).toBe(true);
    expect(reopened.getState().record(notice, at)).toBe(false);
  });

  it("preserves safe ordinary text and all priority events", () => {
    const store = createNotificationHistory(() => localStorage);
    const title = "MCP server sample didn't start: OAuth reauthentication required";
    const body =
      "Cookie settings need review. Authentication is required. Codex ignored an unknown feature.";
    expect(store.getState().record({ ...notice, title, body })).toBe(true);
    expect(store.getState().entries[0]).toMatchObject({ title, body, source: "Codex MCP startup" });
    for (const kind of ["error", "needsInput", "done"] as const) {
      const important = { ...notice, kind, title: "Authorization: invented-auth" };
      expect(store.getState().record(important)).toBe(true);
      expect(store.getState().record(important)).toBe(true);
    }
    const restored = createNotificationHistory(() => localStorage);
    expect(restored.getState().entries).toHaveLength(7);
    expect(restored.getState().entries.filter((e) => e.kind !== "info")).toHaveLength(6);
    expect(restored.getState().entries.find((e) => e.kind === "info")).toMatchObject({
      title,
      body,
    });
    expect(localStorage.getItem(NOTIFICATIONS_KEY)).not.toContain("invented-auth");
  });
});

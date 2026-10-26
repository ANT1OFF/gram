import { beforeEach, describe, expect, it, vi } from "vitest";

/** An Electron notification as far as `windows.ts` drives one. */
class FakeNotification {
  static all: FakeNotification[] = [];
  static isSupported = () => true;
  readonly events: string[] = [];
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    FakeNotification.all.push(this);
  }
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  show() {
    this.events.push("show");
  }
  close() {}
}

vi.mock("node:fs", () => ({ readFileSync: () => "", writeFileSync: () => {} }));
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: {},
  nativeTheme: { themeSource: "system", prefersReducedTransparency: false },
  Notification: FakeNotification,
}));

const windows = await import("./windows.ts");

beforeEach(() => {
  FakeNotification.all = [];
});

describe("watchNotifications", () => {
  it("sees every notification before it shows, and which is Settings' test", () => {
    const seen: Array<{ title: unknown; test: boolean; shownYet: boolean }> = [];
    windows.watchNotifications((note, test) => {
      const fake = note as unknown as FakeNotification;
      seen.push({ title: fake.options["title"], test, shownYet: fake.events.includes("show") });
    });
    windows.notify({ title: "Allow git push?", body: "agent-platform", id: "ask-1" }, null);
    windows.notifyShell({ title: "Gram notifications work", body: "test", test: true });
    windows.notifyShell({ title: "A reminder", body: "later" });
    expect(seen).toEqual([
      { title: "Allow git push?", test: false, shownYet: false },
      { title: "Gram notifications work", test: true, shownYet: false },
      { title: "A reminder", test: false, shownYet: false },
    ]);
    expect(FakeNotification.all.every((note) => note.events.includes("show"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { browserWindow } from "./window-identity";

const memoryStorage = (): Storage => {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  };
};

describe("browserWindow", () => {
  it("makes a plain tab the Main window and keeps its id across reloads", () => {
    const storage = memoryStorage();
    const first = browserWindow(storage, "");
    expect(first).toMatchObject({ name: "Main", primary: true });
    expect(browserWindow(storage, "")).toEqual(first);
  });

  it("names a tab opened for a thread and remembers it without the query", () => {
    const storage = memoryStorage();
    expect(browserWindow(storage, "?window=tab-2&name=Window%202&open=t-flaky")).toEqual({
      id: "tab-2",
      name: "Window 2",
      primary: false,
      initialThreadId: "t-flaky",
    });
    expect(browserWindow(storage, "")).toEqual({ id: "tab-2", name: "Window 2", primary: false });
  });

  it("starts over from a malformed record", () => {
    const storage = memoryStorage();
    storage.setItem("gram.window", "{nope");
    expect(browserWindow(storage, "")).toMatchObject({ name: "Main", primary: true });
  });
});

import { describe, expect, it } from "vitest";

import { lastWindowClosed, parseTrayPrefs } from "./tray-mode.ts";

describe("lastWindowClosed", () => {
  it("quits on Windows and Linux unless the tray is kept, and stays on macOS", () => {
    expect(lastWindowClosed("win32", false)).toBe("quit");
    expect(lastWindowClosed("linux", false)).toBe("quit");
    expect(lastWindowClosed("win32", true)).toBe("tray");
    expect(lastWindowClosed("darwin", false)).toBe("stay");
    expect(lastWindowClosed("darwin", true)).toBe("stay");
  });
});

describe("parseTrayPrefs", () => {
  it("reads only true as on, and anything unreadable as off", () => {
    expect(parseTrayPrefs('{"keepInTray":true,"noticeShown":true}')).toEqual({
      keepInTray: true,
      noticeShown: true,
    });
    expect(parseTrayPrefs('{"keepInTray":"yes"}')).toEqual({
      keepInTray: false,
      noticeShown: false,
    });
    expect(parseTrayPrefs("{torn")).toEqual({ keepInTray: false, noticeShown: false });
    expect(parseTrayPrefs("null")).toEqual({ keepInTray: false, noticeShown: false });
  });
});

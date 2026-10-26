import { describe, expect, it } from "vitest";

import {
  grantPermission,
  permissionCheckAsk,
  permissionRequestAsk,
  badgeCount,
  isAllowedExternalUrl,
  isPortNumber,
  isRevealablePath,
  isThreadIdArg,
  isTrustedSenderUrl,
  isWindowId,
  overlayDotBitmap,
  parseGridLayout,
  parseInstallIntent,
  parseNotification,
  parseTitleBarTheme,
} from "./rules.ts";

describe("window rules", () => {
  it("accepts shell window ids and short thread ids only", () => {
    expect(isWindowId("w1")).toBe(true);
    expect(isWindowId("w12345")).toBe(false);
    expect(isWindowId("../w1")).toBe(false);
    expect(isThreadIdArg("t-flaky")).toBe(true);
    expect(isThreadIdArg("6388bb4d-fbb7-4587-a21b-2dd5ed5f1fe6")).toBe(true);
    expect(isThreadIdArg("../etc")).toBe(false);
    expect(isThreadIdArg(42)).toBe(false);
  });

  it("checks a pane grid loosely", () => {
    const layout = { preset: "2c", panes: ["t-a", null], focused: 0 };
    expect(parseGridLayout(layout)).toBe(layout);
    expect(parseGridLayout({ preset: "2c" })).toBeNull();
    expect(parseGridLayout({ preset: "2c", panes: ["../x"] })).toBeNull();
    expect(parseGridLayout("2c")).toBeNull();
  });
});

describe("isRevealablePath", () => {
  it("allows only absolute local paths", () => {
    for (const path of ["/Users/dev/code/api/src/a.ts", "C:\\Users\\dev\\a.ts", "D:/code"]) {
      expect(isRevealablePath(path), path).toBe(true);
    }
    for (const path of [
      "src/a.ts",
      "//server/share/a.ts",
      "\\\\server\\share\\a.ts",
      "file:///etc/passwd",
      "/a\0b",
      "",
      42,
    ]) {
      expect(isRevealablePath(path), String(path)).toBe(false);
    }
  });
});

describe("isAllowedExternalUrl", () => {
  it("allows only absolute http(s) URLs", () => {
    expect(isAllowedExternalUrl("https://github.com/EXAMPLE/x/pull/1")).toBe(true);
    expect(isAllowedExternalUrl("http://localhost:3000/")).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "smb://host/share",
      "/relative",
      "",
      42,
    ]) {
      expect(isAllowedExternalUrl(url), String(url)).toBe(false);
    }
  });

  it("opens a local port by its number alone", () => {
    expect(isPortNumber(3000)).toBe(true);
    for (const port of [0, 65_536, 3000.5, "3000", "3000/admin", Number.NaN]) {
      expect(isPortNumber(port), String(port)).toBe(false);
    }
  });
});

describe("isTrustedSenderUrl", () => {
  const origins = new Set(["http://127.0.0.1:51041"]);

  it("trusts only pages on a listed origin", () => {
    expect(isTrustedSenderUrl("http://127.0.0.1:51041/threads/abc", origins)).toBe(true);
    expect(isTrustedSenderUrl("http://127.0.0.1:9999/", origins)).toBe(false);
    expect(isTrustedSenderUrl("https://evil.example/", origins)).toBe(false);
    expect(isTrustedSenderUrl("not a url", origins)).toBe(false);
    expect(isTrustedSenderUrl(undefined, origins)).toBe(false);
  });
});

describe("parseTitleBarTheme", () => {
  it("accepts hex colours and a known mode", () => {
    expect(
      parseTitleBarTheme({ background: "#16161e", foreground: "#C0CAF5", mode: "dark" }),
    ).toEqual({
      background: "#16161e",
      foreground: "#C0CAF5",
      mode: "dark",
    });
    expect(
      parseTitleBarTheme({ background: "#fff", foreground: "#00000080", mode: "system" }),
    ).not.toBeNull();
  });

  it("rejects anything else", () => {
    for (const input of [
      null,
      { background: "red", foreground: "#fff", mode: "dark" },
      { background: "#fff", foreground: "#fff", mode: "sepia" },
      { background: "#fff; x", foreground: "#fff", mode: "light" },
    ]) {
      expect(parseTitleBarTheme(input)).toBeNull();
    }
  });
});

describe("parseNotification", () => {
  it("keeps title, body and an optional thread id, bounded in length", () => {
    expect(parseNotification({ title: "Done", body: "Thread finished", threadId: "t1" })).toEqual({
      title: "Done",
      body: "Thread finished",
      threadId: "t1",
    });
    expect(parseNotification({ title: "x", body: "y" })).toEqual({ title: "x", body: "y" });
    expect(parseNotification({ title: "x".repeat(2000), body: "" })?.title).toHaveLength(500);
  });

  it("rejects malformed input", () => {
    for (const input of [
      undefined,
      "hi",
      { title: 1, body: "" },
      { title: "x", body: "y", threadId: 7 },
      { title: "x", body: "y", id: "has space" },
      { title: "x", body: "y", id: "a".repeat(65) },
      { title: "x", body: "y", id: "a", actions: ["Allow always"] },
      { title: "x", body: "y", id: "a", actions: "Allow" },
      { title: "x", body: "y", subtitle: 1 },
    ]) {
      expect(parseNotification(input)).toBeNull();
    }
  });

  it("keeps an ask's Allow only on a body shown whole", () => {
    const ask = { title: "Allow git push?", subtitle: "api · Queue worker", id: "ask-1" };
    expect(
      parseNotification({ ...ask, body: "git push -u origin feat/x", actions: ["Allow"] }),
    ).toEqual({ ...ask, body: "git push -u origin feat/x", actions: ["Allow"] });
    // Cut by the banner, hidden by a bidi override, or with no id to answer by: Open only.
    for (const input of [
      { ...ask, body: "x".repeat(200), actions: ["Allow"] },
      { ...ask, body: "echo ok‮; rm -rf ~", actions: ["Merge"] },
      { title: "x", body: "git push", actions: ["Allow"] },
      { ...ask, body: "git push", actions: ["Allow", "Merge"] },
    ]) {
      expect(parseNotification(input)?.actions).toBeUndefined();
    }
  });
});

describe("parseInstallIntent", () => {
  it("drops renderer-supplied source and asset identity fields", () => {
    const intent = {
      channel: "stable",
      tag: "v1.2.0",
      downgrade: false,
      installId: "00000000-0000-4000-8000-000000000000",
    };
    expect(
      parseInstallIntent({
        ...intent,
        sourceCommit: "a".repeat(40),
        release: { id: 123 },
        assets: [],
      }),
    ).toEqual(intent);
  });

  it("keeps a complete intent and nothing else", () => {
    const intent = { channel: "prerelease", tag: "v1.2.0-rc.1", downgrade: false } as const;
    expect(parseInstallIntent({ ...intent, extra: 1 })).toEqual(intent);
    expect(parseInstallIntent({ channel: "stable", tag: "v1.0.0", downgrade: true })).toEqual({
      channel: "stable",
      tag: "v1.0.0",
      downgrade: true,
    });
  });

  it("refuses a bare tag, an unknown channel or a missing downgrade flag", () => {
    for (const input of [
      "v1.2.0",
      null,
      { channel: "beta", tag: "v1.2.0", downgrade: false },
      { tag: "v1.2.0", downgrade: false },
      { channel: "stable", tag: 1, downgrade: false },
      { channel: "stable", tag: "v1.2.0" },
      { channel: "stable", tag: "v1.2.0", downgrade: "yes" },
    ]) {
      expect(parseInstallIntent(input)).toBeNull();
    }
  });
});

describe("badgeCount", () => {
  it("clamps to a non-negative integer", () => {
    expect(badgeCount(3)).toBe(3);
    expect(badgeCount(2.7)).toBe(2);
    expect(badgeCount(1e9)).toBe(9999);
    for (const input of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "3", null])
      expect(badgeCount(input)).toBe(0);
  });
});

describe("overlayDotBitmap", () => {
  it("draws an opaque centre and transparent corners", () => {
    const size = 16;
    const bitmap = overlayDotBitmap(size);
    expect(bitmap).toHaveLength(size * size * 4);
    const alpha = (x: number, y: number) => bitmap[(y * size + x) * 4 + 3];
    expect(alpha(8, 8)).toBe(255);
    expect(alpha(0, 0)).toBe(0);
  });
});

/** A media check from the app's own origin, as Electron hands it over. */
const checkMedia = (details: { mediaType?: string }) =>
  grantPermission(
    permissionCheckAsk("media", "http://127.0.0.1:4317", details),
    new Set(["http://127.0.0.1:4317"]),
  );

describe("grantPermission", () => {
  const trusted = new Set(["http://127.0.0.1:4317"]);
  const ask = (permission: string, url: string | undefined, mediaTypes: string[] = []) =>
    grantPermission({ permission, url, mediaTypes }, trusted);

  it("grants the app's own pages the microphone and nothing else of media", () => {
    expect(ask("media", "http://127.0.0.1:4317/thread/1", ["audio"])).toBe(true);
    expect(ask("media", "http://127.0.0.1:4317", ["audio", "video"])).toBe(false);
    expect(ask("media", "http://127.0.0.1:4317", ["video"])).toBe(false);
    expect(ask("media", "http://127.0.0.1:4317", ["unknown"])).toBe(false);
    expect(ask("media", "http://127.0.0.1:4317", [])).toBe(false);
  });

  it("keeps the app's other permissions, and grants nothing to another origin", () => {
    expect(ask("clipboard-sanitized-write", "http://127.0.0.1:4317/")).toBe(true);
    expect(ask("media", "http://127.0.0.1:9999/", ["audio"])).toBe(false);
    expect(ask("media", "https://organization.example.invalid/", ["audio"])).toBe(false);
    expect(ask("clipboard-sanitized-write", "https://organization.example.invalid/")).toBe(false);
    expect(ask("notifications", undefined)).toBe(false);
  });

  it("reads Electron's request and check details so a microphone request can be granted", () => {
    const page = "http://127.0.0.1:4317/thread/1";
    const request = (details: { requestingUrl?: string; mediaTypes?: string[] }) =>
      grantPermission(permissionRequestAsk("media", details, page), trusted);
    // A real microphone request carries its media types; without them nothing can be granted.
    expect(request({ requestingUrl: page, mediaTypes: ["audio"] })).toBe(true);
    expect(request({ mediaTypes: ["audio"] })).toBe(true);
    expect(request({ requestingUrl: page, mediaTypes: ["audio", "video"] })).toBe(false);
    expect(request({ requestingUrl: page })).toBe(false);
    expect(
      request({ requestingUrl: "https://organization.example.invalid/", mediaTypes: ["audio"] }),
    ).toBe(false);

    expect(checkMedia({ mediaType: "audio" })).toBe(true);
    expect(checkMedia({ mediaType: "unknown" })).toBe(true);
    expect(checkMedia({})).toBe(true);
    expect(checkMedia({ mediaType: "video" })).toBe(false);
  });

  it("refuses the microphone too for a shell that carries nothing that listens", () => {
    const quiet = { microphone: false };
    const page = "http://127.0.0.1:4317/";
    expect(
      grantPermission({ permission: "media", url: page, mediaTypes: ["audio"] }, trusted, quiet),
    ).toBe(false);
    expect(
      grantPermission(
        { permission: "clipboard-sanitized-write", url: page, mediaTypes: [] },
        trusted,
        quiet,
      ),
    ).toBe(true);
  });
});

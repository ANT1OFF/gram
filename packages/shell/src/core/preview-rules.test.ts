import { describe, expect, it } from "vitest";

import {
  loopbackPortOf,
  parsePreviewBounds,
  previewNavigation,
  previewRequest,
  previewsToClose,
  previewThreadOf,
  windowRect,
} from "./preview-rules.ts";

describe("the preview's navigations", () => {
  it("loads loopback pages, and only those, as written", () => {
    expect(previewNavigation("http://localhost:5173/")).toBe("load");
    expect(previewNavigation("http://127.0.0.1:3000/app?x=1")).toBe("load");
    expect(previewNavigation("https://[::1]:8443/")).toBe("load");
    expect(previewNavigation("about:blank")).toBe("load");
  });

  it("sends a web page elsewhere to the user's browser", () => {
    expect(previewNavigation("https://github.com/EXAMPLE")).toBe("external");
    expect(previewNavigation("http://organization.example.invalid/")).toBe("external");
    expect(previewNavigation("http://localhost.evil.example:3000/")).toBe("external");
    expect(previewNavigation("http://127.0.0.2:3000/")).toBe("external");
    // A user name before the host is a look-alike; the link question names the real host.
    expect(previewNavigation("http://localhost:3000@evil.example/")).toBe("external");
  });

  it("refuses every other scheme", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>hi",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "not a url",
    ]) {
      expect(previewNavigation(url), url).toBe("refuse");
    }
  });

  it("checks a redirect as it checks any other navigation", () => {
    // `will-redirect` hands each hop's target to the same rule.
    expect(previewNavigation("https://login.microsoftonline.com/")).toBe("external");
    expect(previewNavigation("http://localhost:3000/callback")).toBe("load");
  });
});

describe("the preview's requests", () => {
  it("lets loopback requests and sockets through, and the page's own data", () => {
    expect(previewRequest("http://localhost:5173/src/main.tsx")).toBe("allow");
    expect(previewRequest("ws://localhost:5173/?token=hmr")).toBe("allow");
    expect(previewRequest("wss://127.0.0.1:8443/")).toBe("allow");
    expect(previewRequest("data:image/png;base64,AAAA")).toBe("allow");
    expect(previewRequest("blob:http://localhost:5173/1234")).toBe("allow");
  });

  it("blocks anything off loopback, a CDN or an internal site alike", () => {
    expect(previewRequest("https://fonts.googleapis.com/css2")).toBe("block");
    expect(previewRequest("https://organization.example.invalid/logo.png")).toBe("block");
    expect(previewRequest("wss://organization.example.invalid/")).toBe("block");
    expect(previewRequest("file:///etc/passwd")).toBe("block");
    expect(previewRequest("ftp://localhost/")).toBe("block");
  });

  it("reads the port a loopback URL names, defaults included", () => {
    expect(loopbackPortOf("http://localhost/")).toBe(80);
    expect(loopbackPortOf("https://127.0.0.1/")).toBe(443);
    expect(loopbackPortOf("ws://[::1]:9229/")).toBe(9229);
    expect(loopbackPortOf("http://user@localhost:3000/")).toBeUndefined();
    expect(loopbackPortOf("http://organization.example.invalid:3000/")).toBeUndefined();
  });
});

describe("the preview's place in the window", () => {
  it("takes a rectangle in range, null to hide, and drops anything else", () => {
    expect(parsePreviewBounds({ x: 10, y: 20.5, width: 300, height: 200 })).toEqual({
      x: 10,
      y: 20.5,
      width: 300,
      height: 200,
    });
    expect(parsePreviewBounds(null)).toBeNull();
    expect(parsePreviewBounds(undefined)).toBeUndefined();
    expect(parsePreviewBounds({ x: 0, y: 0, width: -1, height: 10 })).toBeUndefined();
    expect(parsePreviewBounds({ x: 0, y: 0, width: Number.NaN, height: 10 })).toBeUndefined();
    expect(parsePreviewBounds({ x: 0, y: 0, width: 1e9, height: 10 })).toBeUndefined();
    expect(parsePreviewBounds({ x: "0", y: 0, width: 10, height: 10 })).toBeUndefined();
  });

  it("scales by the page's zoom, rounding outward", () => {
    expect(windowRect({ x: 10, y: 20, width: 300, height: 200 }, 1)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(windowRect({ x: 10.4, y: 20.6, width: 99.9, height: 50 }, 1.25)).toEqual({
      x: 13,
      y: 25,
      width: 125,
      height: 64,
    });
  });
});

/** The threads a window shows the preview of. */
const shown = (threadId: string) => threadId === "t-a" || threadId === "t-c";

describe("which previews stay loaded", () => {
  it("closes the least recent past the cap, sparing the ones a window shows", () => {
    expect(previewsToClose(["t-a", "t-b", "t-c", "t-d"], shown)).toEqual([]);
    expect(previewsToClose(["t-a", "t-b", "t-c", "t-d", "t-e"], shown)).toEqual(["t-b"]);
    expect(previewsToClose(["t-a", "t-b", "t-c", "t-d", "t-e", "t-f"], shown)).toEqual([
      "t-b",
      "t-d",
    ]);
    // Past the cap with every one shown, as with many windows, the oldest shown one goes.
    expect(previewsToClose(["t-a", "t-c", "t-x"], shown, 2)).toEqual(["t-x"]);
    expect(previewsToClose(["t-a", "t-c"], shown, 1)).toEqual(["t-a"]);
  });

  it("reads the thread a page names, and nothing else", () => {
    expect(previewThreadOf({ threadId: "t-abc_1", url: "http://localhost:3000/" })).toBe("t-abc_1");
    expect(previewThreadOf({ threadId: "../x" })).toBeUndefined();
    expect(previewThreadOf({ threadId: 3 })).toBeUndefined();
    expect(previewThreadOf("t-a")).toBeUndefined();
    expect(previewThreadOf(null)).toBeUndefined();
  });
});

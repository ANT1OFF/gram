import { describe, expect, it } from "vitest";

import {
  addressZone,
  hostZone,
  loopbackPortOf,
  parsePreviewBounds,
  previewNavigation,
  previewRequest,
  previewsToClose,
  previewThreadOf,
  grantKey,
  proxyTargets,
  resolvedWithin,
  webNavigation,
  webRequest,
  windowRect,
  zoneOf,
} from "./preview-rules.ts";

describe("the preview's navigations", () => {
  it("loads loopback pages, and only those, as written", () => {
    expect(previewNavigation("http://localhost:5173/")).toBe("load");
    expect(previewNavigation("http://127.0.0.1:3000/app?x=1")).toBe("load");
    expect(previewNavigation("https://[::1]:8443/")).toBe("load");
    expect(previewNavigation("about:blank")).toBe("load");
  });

  it("opens a web page elsewhere in the thread's web session", () => {
    expect(previewNavigation("https://github.com/EXAMPLE")).toBe("web");
    expect(previewNavigation("http://organization.example.invalid/")).toBe("web");
    expect(previewNavigation("http://localhost.evil.example:3000/")).toBe("web");
    // Not a loopback host the local session loads; the web session refuses it as loopback.
    expect(previewNavigation("http://127.0.0.2:3000/")).toBe("web");
  });

  it("refuses a user name before the host, a look-alike, on loopback or not", () => {
    expect(previewNavigation("http://localhost:3000@evil.example/")).toBe("refuse");
    expect(previewNavigation("https://evil.example@github.com/")).toBe("refuse");
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
    expect(previewNavigation("https://login.microsoftonline.com/")).toBe("web");
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

describe("the web session's zones", () => {
  it("knows this computer by every spelling of it", () => {
    for (const host of [
      "localhost",
      "LOCALHOST.",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.10",
      "0.0.0.0",
      "[::1]",
      "[::]",
      "[::ffff:7f00:1]",
    ]) {
      expect(hostZone(host), host).toBe("loopback");
    }
    expect(addressZone("127.0.0.1")).toBe("loopback");
    expect(addressZone("::1")).toBe("loopback");
    expect(addressZone("::ffff:127.0.0.1")).toBe("loopback");
  });

  it("knows a private network by its addresses and its names", () => {
    for (const host of [
      "10.1.2.3",
      "192.168.1.1",
      "172.16.0.9",
      "169.254.169.254",
      "100.64.0.1",
      "[fd00::1]",
      "[fe80::1]",
      "[::ffff:a00:1]",
      "intranet",
      "nas.local",
      "wiki.corp",
      "printer.home.arpa",
    ]) {
      expect(hostZone(host), host).toBe("private");
    }
    expect(addressZone("192.168.0.4")).toBe("private");
    expect(addressZone("fc00::2")).toBe("private");
  });

  it("knows the internet by everything else", () => {
    expect(hostZone("example.com")).toBe("public");
    expect(hostZone("login.microsoftonline.com")).toBe("public");
    expect(hostZone("203.0.113.9")).toBe("public");
    expect(hostZone("[2606:4700::1111]")).toBe("public");
    expect(addressZone("93.184.216.34")).toBe("public");
    expect(addressZone("2606:4700::1111")).toBe("public");
  });

  it("counts an opaque or unreadable origin as public", () => {
    expect(zoneOf("null")).toBe("public");
    expect(zoneOf(undefined)).toBe("public");
    expect(zoneOf("data:text/html,x")).toBe("public");
    expect(zoneOf("http://192.168.1.1")).toBe("private");
    expect(zoneOf("https://example.com")).toBe("public");
  });
});

describe("the web session's navigations", () => {
  it("loads any http(s) page off loopback, and sends loopback to the link question", () => {
    expect(webNavigation("https://example.com/")).toBe("load");
    expect(webNavigation("http://192.168.1.1/")).toBe("load");
    expect(webNavigation("about:blank")).toBe("load");
    expect(webNavigation("http://localhost:3000/")).toBe("local");
    expect(webNavigation("http://127.0.0.2/")).toBe("local");
    expect(webNavigation("http://app.localhost/")).toBe("local");
  });

  it("refuses every other scheme, and a user name before the host", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<p>hi",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "zoommtg://zoom.us/join",
      "https://evil.example@example.com/",
      "not a url",
    ]) {
      expect(webNavigation(url), url).toBe("refuse");
    }
  });
});

describe("the web session's requests", () => {
  const page = "https://example.com/";

  it("looks up a public name before the page loads it, so a rebound name is caught", () => {
    expect(webRequest({ url: page, mainFrame: true })).toEqual({
      kind: "resolve",
      host: "example.com",
      bound: "private",
    });
    expect(
      webRequest({ url: "https://cdn.example.net/a.js", mainFrame: false, initiator: page }),
    ).toEqual({ kind: "resolve", host: "cdn.example.net", bound: "public" });
    expect(
      webRequest({ url: "wss://live.example.net/", mainFrame: false, initiator: page }),
    ).toEqual({ kind: "resolve", host: "live.example.net", bound: "public" });
    expect(webRequest({ url: "https://203.0.113.9/", mainFrame: false, initiator: page })).toEqual({
      kind: "allow",
    });
  });

  it("never reaches this computer, whoever asks", () => {
    for (const url of [
      "http://127.0.0.1:4317/api/threads",
      "http://localhost:5173/",
      "ws://localhost:4317/ws",
      "http://[::1]:4317/",
      "http://0.0.0.0:4317/",
      "http://gram.localhost/",
      "http://2130706433/",
    ]) {
      expect(webRequest({ url, mainFrame: true }), url).toEqual({ kind: "block" });
      expect(webRequest({ url, mainFrame: false, initiator: page }), url).toEqual({
        kind: "block",
      });
    }
  });

  it("lets the user open a private network's page, but never a public page send one there", () => {
    expect(webRequest({ url: "http://192.168.1.1/", mainFrame: true })).toEqual({ kind: "allow" });
    for (const request of [
      { url: "http://192.168.1.1/", mainFrame: true, initiator: "https://example.com" },
      { url: "http://192.168.1.1/", mainFrame: true, before: "https://example.com/go" },
      { url: "http://nas.local/", mainFrame: false, initiator: "https://example.com" },
      { url: "http://169.254.169.254/latest/", mainFrame: false, initiator: "null" },
      { url: "http://10.0.0.1/", mainFrame: false, page: "https://example.com/" },
      { url: "http://10.0.0.1/", mainFrame: false },
    ]) {
      expect(webRequest(request), JSON.stringify(request)).toEqual({ kind: "block" });
    }
    // A private page loads its own network, and the internet.
    expect(
      webRequest({ url: "http://10.0.0.2/x.css", mainFrame: false, initiator: "http://10.0.0.1" }),
    ).toEqual({ kind: "allow" });
    expect(
      webRequest({
        url: "https://cdn.example.net/",
        mainFrame: false,
        initiator: "http://10.0.0.1",
      }),
    ).toEqual({ kind: "resolve", host: "cdn.example.net", bound: "private" });
  });

  it("refuses other schemes, a top-level data page and a user name", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "devtools://devtools/",
      "chrome-extension://abc/x.js",
      "ftp://example.com/",
      "data:text/html,<script>1</script>",
      "ws://example.com/",
      "https://user:pw@example.com/",
    ]) {
      expect(webRequest({ url, mainFrame: true }), url).toEqual({ kind: "block" });
    }
    expect(
      webRequest({ url: "data:image/png;base64,AA", mainFrame: false, initiator: page }),
    ).toEqual({ kind: "allow" });
    expect(webRequest({ url: "file:///etc/passwd", mainFrame: false, initiator: page })).toEqual({
      kind: "block",
    });
  });
});

const answering = (addresses: readonly string[]) => async () => addresses;
const rejects = () => Promise.reject(new Error("SERVFAIL"));
const throws = () => {
  throw new Error("resolver gone");
};

describe("the web session's lookups", () => {
  it("allows a host only when every address it answers is within the page's zone", async () => {
    expect(await resolvedWithin(answering(["93.184.216.34"]), "example.com", "public")).toBe(true);
    expect(
      await resolvedWithin(answering(["93.184.216.34", "10.0.0.1"]), "example.com", "public"),
    ).toBe(false);
    expect(await resolvedWithin(answering(["10.0.0.1"]), "example.com", "private")).toBe(true);
    expect(await resolvedWithin(answering(["127.0.0.1"]), "example.com", "private")).toBe(false);
    expect(await resolvedWithin(answering(["0:0:0:0:0:0:0:1"]), "example.com", "private")).toBe(
      false,
    );
  });

  it("fails closed on a lookup that rejects, throws or answers nothing", async () => {
    expect(await resolvedWithin(rejects, "example.com", "private")).toBe(false);
    expect(await resolvedWithin(throws, "example.com", "private")).toBe(false);
    expect(await resolvedWithin(answering([]), "example.com", "private")).toBe(false);
    expect(await resolvedWithin(async () => undefined as never, "example.com", "private")).toBe(
      false,
    );
  });
});

describe("the web session's proxy targets", () => {
  it("connects a public name only to the public addresses it answered", () => {
    expect(proxyTargets("example.com", ["93.184.216.34", "2606:2800:220:1::1"])).toEqual([
      "93.184.216.34",
      "2606:2800:220:1::1",
    ]);
  });

  it("refuses a public name answering any private or loopback address, a rebound one", () => {
    expect(proxyTargets("example.com", ["93.184.216.34", "127.0.0.1"])).toBeUndefined();
    expect(proxyTargets("example.com", ["10.0.0.5"])).toBeUndefined();
    expect(proxyTargets("example.com", ["::ffff:7f00:1"])).toBeUndefined();
    expect(proxyTargets("example.com", ["fe80::1%en0"])).toBeUndefined();
  });

  it("refuses a name that answers nothing, or couldn't be looked up", () => {
    expect(proxyTargets("example.com", [])).toBeUndefined();
    expect(proxyTargets("example.com", undefined)).toBeUndefined();
  });

  it("reaches a private name or address only where the request check granted it", () => {
    // Granted: a page or load allowed a private network asked for this host and port just now.
    expect(proxyTargets("nas.local", ["192.168.1.20"], true)).toEqual(["192.168.1.20"]);
    expect(proxyTargets("192.168.1.1", undefined, true)).toEqual(["192.168.1.1"]);
    expect(proxyTargets("[fd00::1]", undefined, true)).toEqual(["fd00::1"]);
    // Not granted: WebRTC, a preconnect, a public page's socket.
    for (const host of ["10.77.0.9", "192.168.1.1", "169.254.169.254", "fd00::1", "nas.local"]) {
      expect(proxyTargets(host, ["192.168.1.20"]), host).toBeUndefined();
    }
    expect(proxyTargets("203.0.113.9", undefined)).toEqual(["203.0.113.9"]);
  });

  it("never reaches loopback, granted or not", () => {
    expect(proxyTargets("nas.local", ["127.0.0.1"], true)).toBeUndefined();
    for (const host of [
      "127.0.0.1",
      "0.0.0.0",
      "localhost",
      "a.localhost",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(proxyTargets(host, ["93.184.216.34"], true), host).toBeUndefined();
    }
  });

  it("keys a grant the same from a request's URL and from the proxy's connection", () => {
    expect(grantKey("10.0.0.1", 443)).toBe("10.0.0.1:443");
    expect(grantKey("[fd00::1]", 80)).toBe("[fd00::1]:80");
    expect(grantKey("fd00::1", 80)).toBe("[fd00::1]:80");
    expect(grantKey("NAS.local", 8080)).toBe("nas.local:8080");
    expect(grantKey("0xa000001", 80)).toBe("10.0.0.1:80");
    expect(grantKey("10.0.0.1", 0)).toBeUndefined();
    expect(grantKey("bad host", 80)).toBeUndefined();
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

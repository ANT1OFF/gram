import { createServer, type Server } from "node:http";
import { PassThrough } from "node:stream";

import type { PaneCommand } from "@gram/contracts/link-trust";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NO_BROWSER, headlessPanes, offLoopback } from "./headless-host.ts";
import {
  headlessArgs,
  openHeadlessPage,
  pipeConnection,
  type CdpConnection,
  type HeadlessGate,
} from "./headless.ts";

/** A browser that answers the commands a page needs and lets each test pause a request. */
const fakeBrowser = () => {
  const listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>();
  const sent: Array<{ method: string; params?: object; sessionId?: string }> = [];
  let attached = 0;
  const connection: CdpConnection = {
    send: async (method, params, sessionId) => {
      sent.push({ method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
      switch (method) {
        case "Target.createBrowserContext":
          return { browserContextId: "context-1" };
        case "Target.createTarget":
          return { targetId: "target-1" };
        case "Target.attachToTarget":
          return { sessionId: attached++ === 0 ? "own" : "debugger" };
        case "Page.getFrameTree":
          return { frameTree: { frame: { id: "main", url: "about:blank" } } };
        case "Page.getNavigationHistory":
          return { currentIndex: 0, entries: [{ id: 1 }] };
        case "Target.getTargetInfo":
          return { targetInfo: { title: "Owned" } };
        default:
          return {};
      }
    },
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => {},
    close: () => {},
  };
  const emit = (method: string, params: unknown, sessionId?: string) => {
    for (const listener of Array.from(listeners)) listener(method, params, sessionId);
  };
  /** Pauses one request of the page and waits for the verdict the page sends back. */
  const pause = async (url: string, resourceType: string, frameId = "main") => {
    const before = sent.length;
    emit(
      "Fetch.requestPaused",
      { requestId: `r-${before}`, request: { url, method: "GET" }, frameId, resourceType },
      "own",
    );
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const verdict = sent
        .slice(before)
        .find(
          (entry) =>
            entry.method === "Fetch.continueRequest" || entry.method === "Fetch.failRequest",
        );
      if (verdict !== undefined)
        return verdict.method === "Fetch.continueRequest" ? "allow" : "block";
    }
    throw new Error("No verdict for the paused request.");
  };
  return { connection, sent, emit, pause };
};

describe("headlessArgs", () => {
  it("sends everything but loopback to a closed proxy, and drops the sandbox only when told", () => {
    expect(headlessArgs("/tmp/profile", true)).toContain("--proxy-server=http://127.0.0.1:9");
    expect(headlessArgs("/tmp/profile", true)).not.toContain("--no-sandbox");
    expect(headlessArgs("/tmp/profile", false)).toContain("--no-sandbox");
  });
});

describe("pipeConnection", () => {
  it("frames commands with NUL, matches replies by id and hands events on", async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const connection = pipeConnection(toBrowser, fromBrowser);
    const events: Array<[string, unknown, string | undefined]> = [];
    connection.on((method, params, sessionId) => events.push([method, params, sessionId]));
    const written: Array<string> = [];
    toBrowser.on("data", (chunk: Buffer) => written.push(chunk.toString()));
    const reply = connection.send("Page.navigate", { url: "http://127.0.0.1:3000/" }, "s1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written.join("")).toBe(
      `${JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "http://127.0.0.1:3000/" }, sessionId: "s1" })}\0`,
    );
    // One reply split across chunks, and an event in the same chunk as its end.
    fromBrowser.write('{"id":1,"result":{"frame');
    fromBrowser.write('Id":"f"}}\0{"method":"Page.loadEventFired","params":{},"sessionId":"s1"}\0');
    expect(await reply).toEqual({ frameId: "f" });
    expect(events).toEqual([["Page.loadEventFired", {}, "s1"]]);
    const refused = connection.send("Nope.nope");
    fromBrowser.write('{"id":2,"error":{"message":"not found"}}\0');
    await expect(refused).rejects.toThrow("not found");
  });

  it("fails what's waiting when the browser goes away", async () => {
    const fromBrowser = new PassThrough();
    const connection = pipeConnection(new PassThrough(), fromBrowser);
    let closed = false;
    connection.onClose(() => {
      closed = true;
    });
    const waiting = connection.send("Page.enable");
    fromBrowser.destroy();
    await expect(waiting).rejects.toThrow("The browser closed.");
    expect(closed).toBe(true);
    await expect(connection.send("Page.enable")).rejects.toThrow("The browser closed.");
  });
});

describe("openHeadlessPage", () => {
  it("opens each page in a context of its own and pauses every request", async () => {
    const browser = fakeBrowser();
    const page = await openHeadlessPage(browser.connection, () => undefined);
    expect(page.getURL()).toBe("about:blank");
    const methods = browser.sent.map((entry) => entry.method);
    expect(methods.slice(0, 3)).toEqual([
      "Target.createBrowserContext",
      "Target.createTarget",
      "Target.attachToTarget",
    ]);
    expect(browser.sent).toContainEqual({
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
      sessionId: "own",
    });
    expect(browser.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.createTarget",
        params: { url: "about:blank", browserContextId: "context-1" },
      }),
    );
  });

  it("with no pane rule, loads loopback and the page's own data and nothing else", async () => {
    const browser = fakeBrowser();
    await openHeadlessPage(browser.connection, () => undefined);
    expect(await browser.pause("http://127.0.0.1:3000/", "Document")).toBe("allow");
    expect(await browser.pause("http://localhost:3000/app.js", "Script")).toBe("allow");
    expect(await browser.pause("data:text/plain,hi", "Image")).toBe("allow");
    expect(await browser.pause("https://example.com/", "Document")).toBe("block");
    expect(await browser.pause("https://example.com/x.js", "Script")).toBe("block");
    expect(await browser.pause("http://10.0.0.5/", "XHR")).toBe("block");
    expect(await browser.pause("file:///etc/passwd", "Document")).toBe("block");
    expect(browser.sent).toContainEqual(
      expect.objectContaining({
        method: "Fetch.failRequest",
        params: expect.objectContaining({ errorReason: "BlockedByClient" }),
      }),
    );
  });

  it("puts a main-frame load to the pane's navigation rule, then its request rule", async () => {
    const browser = fakeBrowser();
    const asked: Array<string> = [];
    let navigation: "load" | "block" | undefined = "block";
    let request: "allow" | "block" = "allow";
    const gate: HeadlessGate = {
      navigation: (_contents, url) => {
        asked.push(`navigation ${url}`);
        return navigation;
      },
      request: (_contents, details) => {
        asked.push(`request ${details.url} main=${details.mainFrame} sub=${details.subFrame}`);
        return Promise.resolve(request);
      },
    };
    const page = await openHeadlessPage(browser.connection, () => gate);
    const started: Array<string> = [];
    page.on("did-start-navigation", (details) => started.push(details.url));

    expect(await browser.pause("http://127.0.0.1:3000/a", "Document")).toBe("block");
    expect(asked).toEqual(["navigation http://127.0.0.1:3000/a"]);
    expect(started).toEqual([]);

    navigation = "load";
    asked.length = 0;
    expect(await browser.pause("http://127.0.0.1:3000/b", "Document")).toBe("allow");
    expect(asked).toEqual([
      "navigation http://127.0.0.1:3000/b",
      "request http://127.0.0.1:3000/b main=true sub=false",
    ]);
    expect(started).toEqual(["http://127.0.0.1:3000/b"]);

    request = "block";
    asked.length = 0;
    expect(await browser.pause("http://127.0.0.1:3000/frame", "Document", "child")).toBe("block");
    expect(asked).toEqual(["request http://127.0.0.1:3000/frame main=false sub=true"]);

    // The pane allowing a request doesn't open the network: off loopback still doesn't go.
    request = "allow";
    expect(await browser.pause("https://example.com/x.js", "Script")).toBe("block");
  });

  it("follows the main frame's address and load, and ends with its target", async () => {
    const browser = fakeBrowser();
    const page = await openHeadlessPage(browser.connection, () => undefined);
    const seen: Array<string> = [];
    page.on("did-navigate", (_event, url) => seen.push(`navigate ${url}`));
    page.once("did-stop-loading", () => seen.push("stopped"));
    page.once("destroyed", () => seen.push("destroyed"));
    browser.emit("Page.frameStartedLoading", { frameId: "main" }, "own");
    expect(page.isLoading()).toBe(true);
    browser.emit(
      "Page.frameNavigated",
      { frame: { id: "main", url: "http://127.0.0.1:3000/" } },
      "own",
    );
    browser.emit(
      "Page.frameNavigated",
      { frame: { id: "ad", parentId: "main", url: "http://127.0.0.1:3000/frame" } },
      "own",
    );
    browser.emit("Page.frameStoppedLoading", { frameId: "main" }, "own");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.isLoading()).toBe(false);
    expect(page.getURL()).toBe("http://127.0.0.1:3000/");
    expect(page.getTitle()).toBe("Owned");
    browser.emit("Target.targetDestroyed", { targetId: "target-1" });
    expect(page.isDestroyed()).toBe(true);
    expect(seen).toEqual(["navigate http://127.0.0.1:3000/", "stopped", "destroyed"]);
  });

  it("gives the pane a debugger session of its own, separate from the page's", async () => {
    const browser = fakeBrowser();
    const page = await openHeadlessPage(browser.connection, () => undefined);
    const messages: Array<string> = [];
    page.debugger.on("message", (_event, method) => messages.push(method));
    expect(page.debugger.isAttached()).toBe(false);
    await expect(page.debugger.sendCommand("DOM.enable")).rejects.toThrow();
    page.debugger.attach();
    expect(page.debugger.isAttached()).toBe(true);
    await page.debugger.sendCommand("DOM.enable", { a: 1 });
    expect(browser.sent).toContainEqual({
      method: "DOM.enable",
      params: { a: 1 },
      sessionId: "debugger",
    });
    browser.emit("Runtime.consoleAPICalled", {}, "own");
    browser.emit("Runtime.consoleAPICalled", {}, "debugger");
    expect(messages).toEqual(["Runtime.consoleAPICalled"]);
    const detached: Array<string> = [];
    page.debugger.on("detach", () => detached.push("detach"));
    browser.emit("Target.detachedFromTarget", { sessionId: "debugger" });
    expect(page.debugger.isAttached()).toBe(false);
    expect(page.isDestroyed()).toBe(false);
    expect(detached).toEqual(["detach"]);
  });
});

const navigateMessage = (command: PaneCommand) => ({
  type: "pane.request",
  id: "1",
  request: { threadId: "t", limits: { actOnLoopbackOnly: false }, command },
});

describe("offLoopback", () => {
  it("refuses a navigation anywhere but loopback, and leaves every other command alone", () => {
    expect(offLoopback(navigateMessage({ op: "navigate", url: "https://example.com/" }))).toBe(
      true,
    );
    expect(offLoopback(navigateMessage({ op: "navigate", url: "http://10.0.0.5/" }))).toBe(true);
    expect(offLoopback(navigateMessage({ op: "navigate", url: "http://127.0.0.1:3000/" }))).toBe(
      false,
    );
    expect(offLoopback(navigateMessage({ op: "navigate", url: "http://localhost:5173/" }))).toBe(
      false,
    );
    expect(offLoopback(navigateMessage({ op: "snapshot" }))).toBe(false);
    expect(offLoopback({ type: "pane.cancel", id: "1" })).toBe(false);
  });
});

describe("headlessPanes", () => {
  it("says the server's browser couldn't open a page when it can't start", async () => {
    const warned: Array<string> = [];
    const { panes, close } = headlessPanes({
      executable: "/nonexistent/gram-test-browser",
      sandbox: true,
      log: { info: () => {}, warn: (_fields, message) => warned.push(message), error: () => {} },
    });
    try {
      const result = await panes.serve({
        threadId: "owned",
        limits: { actOnLoopbackOnly: false },
        command: { op: "navigate", url: "http://127.0.0.1:3000/" },
      });
      expect(result).toEqual(NO_BROWSER);
      expect(warned).toEqual(["no page"]);
    } finally {
      await close();
    }
  });
});

// Against a real Chromium, when `GRAM_BROWSER_EXECUTABLE` names one (Playwright's will do).
const executable = process.env["GRAM_BROWSER_EXECUTABLE"];

describe.skipIf(executable === undefined || executable === "")("headless panes in Chromium", () => {
  let server: Server;
  let origin = "";
  let fetched = 0;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/data") fetched++;
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Owned fixture</title><button onclick="this.textContent='Pressed';document.title='Pressed'">Press me</button>` +
          `<script>fetch('/data');fetch('https://example.com/x').then(()=>{document.body.dataset.out='reached'},()=>{document.body.dataset.out='stopped'})</script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });
  afterAll(() => {
    server.close();
  });

  it("navigates, reads, clicks and captures a loopback page", async () => {
    const { panes, close } = headlessPanes({ executable: executable!, sandbox: false });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      const opened = await command({ op: "navigate", url: `${origin}/` });
      expect(opened).toMatchObject({
        ok: true,
        page: { url: `${origin}/`, title: "Owned fixture" },
      });
      const snapshot = await command({ op: "snapshot" });
      expect(snapshot).toMatchObject({ ok: true });
      expect(snapshot.ok && snapshot.content).toContain('button "Press me" [ref_1]');
      expect(await command({ op: "click", ref: "ref_1" })).toMatchObject({
        ok: true,
        page: { title: "Pressed" },
      });
      const after = await command({ op: "snapshot" });
      expect(after.ok && after.content).toContain('button "Pressed"');
      const shot = await command({ op: "screenshot" });
      expect(shot).toMatchObject({ ok: true, image: { mimeType: "image/jpeg" } });
      expect(fetched).toBeGreaterThan(0);
    } finally {
      await close();
    }
  }, 60_000);
});

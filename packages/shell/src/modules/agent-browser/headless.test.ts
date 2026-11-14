import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { PassThrough } from "node:stream";

import type { PaneCommand, ViewHostMessage } from "@gram/contracts/link-trust";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { NO_BROWSER, STOPPED_ANSWERING, headlessPanes, offLoopback } from "./headless-host.ts";
import {
  HEADLESS_PAGE_LIMIT,
  LOAD_DEADLINE_MS,
  browserEnv,
  headlessArgs,
  headlessViews,
  launchHeadless,
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
  const closers: Array<() => void> = [];
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
    onClose: (listener) => {
      closers.push(listener);
    },
    close: () => {
      for (const closer of closers.splice(0)) closer();
    },
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
        .find((entry) => entry.method.startsWith("Fetch.") && entry.method !== "Fetch.enable");
      if (verdict !== undefined) {
        return verdict.method === "Fetch.continueRequest"
          ? "allow"
          : verdict.method === "Fetch.fulfillRequest"
            ? "stay"
            : "block";
      }
    }
    throw new Error("No verdict for the paused request.");
  };
  return { connection, sent, emit, pause };
};

describe("headlessArgs", () => {
  it("sends everything but loopback to a closed proxy, and drops the sandbox only when told", () => {
    expect(headlessArgs("/tmp/profile", true)).toContain("--proxy-server=http://127.0.0.1:9");
    // Chromium's own bypass reaches link-local addresses too; only loopback is named instead.
    expect(headlessArgs("/tmp/profile", true)).toContain(
      "--proxy-bypass-list=<-loopback>;127.0.0.1;[::1];localhost",
    );
    expect(headlessArgs("/tmp/profile", true)).toContain(
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    );
    // No name but loopback's resolves, so a page can't send data out in a DNS query.
    expect(headlessArgs("/tmp/profile", true)).toContain(
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
    );
    expect(headlessArgs("/tmp/profile", true)).not.toContain("--no-sandbox");
    expect(headlessArgs("/tmp/profile", false)).toContain("--no-sandbox");
  });
});

describe("browserEnv", () => {
  it("keeps where things are and drops tokens and debug switches", () => {
    expect(
      browserEnv({
        PATH: "/usr/bin",
        HOME: "/home/gram",
        LANG: "C.UTF-8",
        NODE_OPTIONS: "--inspect",
        GH_TOKEN: "invented-token",
        HTTPS_PROXY: "http://proxy.invalid:3128",
        GRAM_BROWSER_EXECUTABLE: "/usr/bin/chromium",
      }),
    ).toEqual({ PATH: "/usr/bin", HOME: "/home/gram", LANG: "C.UTF-8" });
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
    // New targets are held first, so nothing the page opens loads before it is looked at.
    expect(methods.slice(0, 4)).toEqual([
      "Target.setAutoAttach",
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
    // A navigation the page started is ended without content, so its document stays.
    expect(await browser.pause("https://example.com/", "Document")).toBe("stay");
    expect(await browser.pause("https://example.com/x.js", "Script")).toBe("block");
    expect(await browser.pause("http://10.0.0.5/", "XHR")).toBe("block");
    expect(await browser.pause("file:///etc/passwd", "Document")).toBe("stay");
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

    expect(await browser.pause("http://127.0.0.1:3000/a", "Document")).toBe("stay");
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

describe("openHeadlessPage, what it closes", () => {
  it("fails the app's own load loudly, so the command that asked hears", async () => {
    const browser = fakeBrowser();
    const page = await openHeadlessPage(browser.connection, () => ({
      navigation: () => "block",
      request: () => undefined,
    }));
    void page.loadURL("http://127.0.0.1:3000/app").catch(() => {});
    expect(await browser.pause("http://127.0.0.1:3000/app", "Document")).toBe("block");
  });

  it("ends every page when the browser goes away, so the next command starts another", async () => {
    const browser = fakeBrowser();
    const views = headlessViews(browser.connection, () => undefined);
    const page = await views.contentsFor("thread-0", true);
    page!.debugger.attach();
    const waiting = page!.debugger.sendCommand("Runtime.evaluate", { expression: "1" });
    browser.connection.close();
    expect(page!.isDestroyed()).toBe(true);
    await waiting.catch(() => {});
    expect(await views.contentsFor("thread-0", false)).toBeUndefined();
  });

  it("sends no detach to a page that is closing", async () => {
    const browser = fakeBrowser();
    const views = headlessViews(browser.connection, () => undefined);
    const page = await views.contentsFor("thread-0", true);
    page!.debugger.attach();
    await page!.debugger.sendCommand("DOM.enable");
    await views.close("thread-0");
    expect(page!.isDestroyed()).toBe(true);
    page!.debugger.detach();
    expect(browser.sent.some((entry) => entry.method === "Target.detachFromTarget")).toBe(false);
    expect(browser.sent.some((entry) => entry.method === "Target.closeTarget")).toBe(true);
  });

  it("stops a load whose server never answers, so the thread's commands go on", async () => {
    vi.useFakeTimers();
    try {
      const browser = fakeBrowser();
      const page = await openHeadlessPage(browser.connection, () => undefined);
      const send = browser.connection.send;
      browser.connection.send = (method, params, sessionId) =>
        method === "Page.navigate" ? new Promise(() => {}) : send(method, params, sessionId);
      const load = page.loadURL("http://127.0.0.1:3000/never");
      const failed = expect(load).rejects.toThrow("The page didn't answer in time.");
      await vi.advanceTimersByTimeAsync(LOAD_DEADLINE_MS);
      await failed;
      expect(browser.sent).toContainEqual({ method: "Page.stopLoading", sessionId: "own" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the thread's own page, closes a window it opens, and gates a worker", async () => {
    const browser = fakeBrowser();
    await openHeadlessPage(browser.connection, () => undefined);
    const attach = (sessionId: string, targetId: string, type: string, context: string) =>
      browser.emit("Target.attachedToTarget", {
        sessionId,
        waitingForDebugger: true,
        targetInfo: { targetId, type, browserContextId: context },
      });
    attach("auto-own", "target-1", "page", "context-1");
    attach("auto-popup", "popup-1", "page", "context-1");
    attach("auto-worker", "worker-1", "service_worker", "context-1");
    attach("auto-ui", "ui-1", "browser_ui", "context-1");
    // A window of the browser's own, which only a browser shortcut opens.
    attach("auto-other", "other", "page", "browser-own");
    browser.emit("Target.attachedToTarget", {
      sessionId: "auto-tools",
      waitingForDebugger: true,
      targetInfo: {
        targetId: "tools",
        type: "other",
        url: "devtools://devtools/bundled/devtools_app.html",
        browserContextId: "context-1",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      browser.sent
        .filter((entry) => entry.method === "Target.closeTarget")
        .map((entry) => (entry.params as { targetId: string }).targetId)
        .toSorted(),
    ).toEqual(["other", "popup-1", "tools"]);
    // Everything is let go, the popup too: held, it would hold the page that opened it.
    const resumed = browser.sent
      .filter((entry) => entry.method === "Runtime.runIfWaitingForDebugger")
      .map((entry) => entry.sessionId);
    expect(resumed.toSorted()).toEqual([
      "auto-other",
      "auto-own",
      "auto-popup",
      "auto-tools",
      "auto-ui",
      "auto-worker",
    ]);
    // But the popup's requests all fail, loopback included.
    const order = browser.sent
      .filter((entry) => entry.sessionId === "auto-popup")
      .map((entry) => entry.method);
    expect(order).toEqual(["Fetch.enable", "Runtime.runIfWaitingForDebugger"]);
    const beforePopup = browser.sent.length;
    browser.emit(
      "Fetch.requestPaused",
      {
        requestId: "p1",
        request: { url: "http://127.0.0.1:3000/popup", method: "GET" },
        frameId: "f",
        resourceType: "Document",
      },
      "auto-popup",
    );
    expect(browser.sent.slice(beforePopup)).toEqual([
      {
        method: "Fetch.failRequest",
        params: { requestId: "p1", errorReason: "BlockedByClient" },
        sessionId: "auto-popup",
      },
    ]);
    expect(browser.sent).toContainEqual(
      expect.objectContaining({ method: "Fetch.enable", sessionId: "auto-worker" }),
    );
    // The worker's own requests get the local rules: loopback goes, anything else doesn't.
    const before = browser.sent.length;
    const paused = (requestId: string, url: string) =>
      browser.emit(
        "Fetch.requestPaused",
        { requestId, request: { url, method: "GET" }, frameId: "", resourceType: "Fetch" },
        "auto-worker",
      );
    paused("w1", "http://127.0.0.1:3000/api");
    paused("w2", "http://169.254.169.254/latest/meta-data/");
    expect(browser.sent.slice(before)).toEqual([
      { method: "Fetch.continueRequest", params: { requestId: "w1" }, sessionId: "auto-worker" },
      {
        method: "Fetch.failRequest",
        params: { requestId: "w2", errorReason: "BlockedByClient" },
        sessionId: "auto-worker",
      },
    ]);
  });
});

describe("headlessViews", () => {
  it("keeps a page for the threads used last, and closes the oldest for the next", async () => {
    const browser = fakeBrowser();
    const closed: Array<string> = [];
    const views = headlessViews(
      browser.connection,
      () => undefined,
      () => {},
      (threadId) => closed.push(threadId),
    );
    const first = await views.contentsFor("thread-0", true);
    for (let i = 1; i < HEADLESS_PAGE_LIMIT; i++) await views.contentsFor(`thread-${i}`, true);
    // A command on thread-0 just now makes thread-1 the one used longest ago.
    views.touch("thread-0");
    expect(closed).toEqual([]);
    await views.contentsFor("another", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual(["thread-1"]);
    expect(first!.isDestroyed()).toBe(false);
    expect(await views.contentsFor("thread-1", false)).toBeUndefined();
    expect(browser.sent.some((entry) => entry.method === "Target.disposeBrowserContext")).toBe(
      true,
    );
  });
});

describe("headlessViews, a page in use", () => {
  it("never closes a page a command is running on, even past the limit", async () => {
    const browser = fakeBrowser();
    const closed: Array<string> = [];
    const views = headlessViews(
      browser.connection,
      () => undefined,
      () => {},
      (threadId) => closed.push(threadId),
      (threadId) => threadId === "thread-0",
    );
    for (let i = 0; i < HEADLESS_PAGE_LIMIT; i++) await views.contentsFor(`thread-${i}`, true);
    await views.contentsFor("another", true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toEqual(["thread-1"]);
  });
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

/** Waits until `met`, for ten seconds at most. */
const until = async (met: () => boolean) => {
  for (let waited = 0; !met() && waited < 10_000; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(met()).toBe(true);
};

describe.skipIf(executable === undefined || executable === "")("headless panes in Chromium", () => {
  let server: Server;
  let origin = "";
  let fetched = 0;
  let popups = 0;
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/data") fetched++;
      if (request.url === "/popup") popups++;
      response.setHeader("content-type", "text/html");
      response.end(
        `<title>Owned fixture</title><button onclick="this.textContent='Pressed';document.title='Pressed'">Press me</button><a target="_blank" href="/popup">Open popup</a><button onclick="window.opened = window.open('/popup')">Open window</button>` +
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

  it("shows a watcher the page and its frames, and gives a person the page for a while", async () => {
    const seen: Array<ViewHostMessage> = [];
    const { panes, view, close } = headlessPanes({
      executable: executable!,
      sandbox: false,
      send: (message) => seen.push(message),
      idleMs: 1_500,
    });
    const pages = () =>
      seen.flatMap((message) => (message.type === "pane.view.page" ? [message] : []));
    const watch = setInterval(() => view({ type: "pane.view.watch", threadId: "owned" }), 500);
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(view({ type: "pane.view.watch", threadId: "owned" })).toBe(true);
      // Watching starts no browser and shows no page before the agent has one.
      await until(() => pages().length > 0);
      expect(pages()[0]).toEqual({ type: "pane.view.page", threadId: "owned", page: null });

      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      await until(() => pages().at(-1)?.page?.title === "Owned fixture");
      expect(pages().at(-1)?.page).toMatchObject({
        url: `${origin}/`,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        driver: "agent",
      });
      await until(() => seen.some((message) => message.type === "pane.view.frame"));
      const frame = seen.find((message) => message.type === "pane.view.frame");
      expect(frame).toMatchObject({ threadId: "owned" });
      // A JPEG, base64: its first bytes are FF D8 FF.
      expect(frame?.type === "pane.view.frame" && frame.jpeg.startsWith("/9j/")).toBe(true);
      expect(frame?.type === "pane.view.frame" && frame.width).toBeGreaterThan(100);

      const at = await command({
        op: "evaluate",
        expression:
          "(() => { const r = document.querySelector('button').getBoundingClientRect(); return JSON.stringify([r.x + r.width / 2, r.y + r.height / 2]); })()",
      });
      const [x, y] = JSON.parse(
        /\[[\d., ]+\]/.exec(at.ok ? (at.content ?? "") : "")?.[0] ?? "[]",
      ) as Array<number>;
      expect(x).toBeGreaterThan(0);
      const pointer = { type: "pointer", x, y, button: "left", clickCount: 1, modifiers: 0 };
      // A pointer passing over the agent's page takes nothing over and reaches nothing.
      view({
        type: "pane.view.input",
        threadId: "owned",
        inputs: [{ ...pointer, action: "move", button: "none", buttons: 0, clickCount: 0 }],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(pages().at(-1)?.page?.driver).toBe("agent");

      view({
        type: "pane.view.input",
        threadId: "owned",
        inputs: [
          { ...pointer, action: "down", buttons: 1 },
          { ...pointer, action: "up", buttons: 0 },
        ],
      });
      await until(() => pages().at(-1)?.page?.driver === "user");
      await until(() => pages().at(-1)?.page?.title === "Pressed");
      expect(await command({ op: "click", ref: "ref_1" })).toMatchObject({
        ok: false,
        code: "userHasControl",
      });

      // With nothing more from the person, the page is the agent's again.
      await until(() => pages().at(-1)?.page?.driver === "agent");
      expect(await command({ op: "text" })).toMatchObject({ ok: true });

      // Typing takes it over too, and the strip's button gives it back at once.
      view({
        type: "pane.view.input",
        threadId: "owned",
        inputs: [
          { type: "key", action: "down", key: "Tab", code: "Tab", keyCode: 9, modifiers: 0 },
        ],
      });
      await until(() => pages().at(-1)?.page?.driver === "user");
      view({ type: "pane.view.control", threadId: "owned", op: "handBack" });
      await until(() => pages().at(-1)?.page?.driver === "agent");
    } finally {
      clearInterval(watch);
      await close();
    }
  }, 60_000);

  it("goes back and forward through the pages as they are now, for a person watching", async () => {
    const seen: Array<ViewHostMessage> = [];
    const { panes, view, close } = headlessPanes({
      executable: executable!,
      sandbox: false,
      send: (message) => seen.push(message),
    });
    const page = () =>
      seen.flatMap((message) => (message.type === "pane.view.page" ? [message] : [])).at(-1)?.page;
    const watch = setInterval(() => view({ type: "pane.view.watch", threadId: "owned" }), 500);
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      view({ type: "pane.view.watch", threadId: "owned" });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      expect(await command({ op: "navigate", url: `${origin}/two` })).toMatchObject({ ok: true });
      await until(() => page()?.url === `${origin}/two` && page()?.canGoBack === true);
      expect(page()?.canGoForward).toBe(false);

      view({ type: "pane.view.control", threadId: "owned", op: "back" });
      await until(() => page()?.url === `${origin}/` && page()?.canGoForward === true);
      // The blank page every page starts on is nowhere to go back to.
      expect(page()).toMatchObject({ canGoBack: false, driver: "user" });
      view({ type: "pane.view.control", threadId: "owned", op: "back" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(page()?.url).toBe(`${origin}/`);

      view({ type: "pane.view.control", threadId: "owned", op: "forward" });
      await until(() => page()?.url === `${origin}/two` && page()?.canGoBack === true);
      expect(page()?.canGoForward).toBe(false);
    } finally {
      clearInterval(watch);
      await close();
    }
  }, 60_000);

  it("keeps the page where it is when the page itself tries to leave loopback", async () => {
    const { panes, close } = headlessPanes({ executable: executable!, sandbox: false });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      await command({ op: "evaluate", expression: "location.href = 'https://example.com/'; 1" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const text = await command({ op: "text" });
      expect(text).toMatchObject({ ok: true, page: { url: `${origin}/` } });
    } finally {
      await close();
    }
  }, 60_000);

  it("closes a window the page opens, so nothing loads outside the checks", async () => {
    const { panes, close } = headlessPanes({ executable: executable!, sandbox: false });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      const before = popups;
      const snapshot = await command({ op: "snapshot" });
      const ref = /link "Open popup" \[(ref_\d+)\]/.exec(
        snapshot.ok ? (snapshot.content ?? "") : "",
      );
      expect(ref).not.toBeNull();
      await command({ op: "click", ref: ref![1]! });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // Still the thread's own page, and usable.
      expect(await command({ op: "text" })).toMatchObject({
        ok: true,
        page: { url: `${origin}/` },
      });
      expect(popups).toBe(before);
    } finally {
      await close();
    }
  }, 60_000);

  // A UDP listener on one of this machine's own addresses that isn't loopback, where there is one.
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)?.address;

  it.skipIf(outside === undefined)(
    "sends no WebRTC packet off loopback, by its flags alone",
    async () => {
      const socket = createSocket("udp4");
      let packets = 0;
      socket.on("message", () => packets++);
      await new Promise<void>((resolve) => socket.bind(0, outside, resolve));
      const { port } = socket.address();
      // A bare page with none of this module's page scripts, so only the flags stand between
      // WebRTC and the network.
      const browser = launchHeadless({ executable: executable!, sandbox: false });
      try {
        const { connection } = browser;
        const { targetId } = (await connection.send("Target.createTarget", {
          url: `${origin}/`,
        })) as { targetId: string };
        const { sessionId } = (await connection.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        })) as { sessionId: string };
        await new Promise((resolve) => setTimeout(resolve, 500));
        const made = (await connection.send(
          "Runtime.evaluate",
          {
            expression: `(() => {
              const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:${outside}:${port}" }] });
              peer.createDataChannel("x");
              peer.createOffer().then((offer) => peer.setLocalDescription(offer));
              return location.origin;
            })()`,
          },
          sessionId,
        )) as { result: { value?: string } };
        expect(made.result.value).toBe(origin);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        expect(packets).toBe(0);
      } finally {
        await browser.close();
        socket.close();
      }
    },
    60_000,
  );

  it("gives a thread's page no WebRTC at all", async () => {
    const { panes, close } = headlessPanes({ executable: executable!, sandbox: false });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      const kinds = await command({
        op: "evaluate",
        expression: "typeof RTCPeerConnection + ' ' + typeof webkitRTCPeerConnection",
      });
      expect(kinds.ok && kinds.content).toContain("undefined undefined");
    } finally {
      await close();
    }
  }, 60_000);

  it("stays usable after a click opens a window with window.open", async () => {
    const { panes, close } = headlessPanes({ executable: executable!, sandbox: false });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      const before = popups;
      const snapshot = await command({ op: "snapshot" });
      const ref = /button "Open window" \[(ref_\d+)\]/.exec(
        snapshot.ok ? (snapshot.content ?? "") : "",
      );
      expect(ref).not.toBeNull();
      expect(await command({ op: "click", ref: ref![1]! })).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const state = await command({
        op: "evaluate",
        expression: "window.opened === null",
      });
      expect(state.ok && state.content).toContain("true");
      expect(popups).toBe(before);
    } finally {
      await close();
    }
  }, 30_000);

  it("dismisses a page's dialog, so its commands go on", async () => {
    const { panes, close } = headlessPanes({ executable: executable!, sandbox: false });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      await command({
        op: "evaluate",
        expression:
          "setTimeout(() => { document.title = 'asked ' + confirm('Delete?'); alert('done'); }, 0); 1",
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const title = await command({ op: "evaluate", expression: "document.title" });
      expect(title.ok && title.content).toContain("asked false");
    } finally {
      await close();
    }
  }, 30_000);

  it("closes a page whose script never yields, and opens a fresh one for the next command", async () => {
    const { panes, close } = headlessPanes({
      executable: executable!,
      sandbox: false,
      deadlineMs: 3_000,
    });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      await command({ op: "evaluate", expression: "setTimeout(() => { while (true) {} }, 0); 1" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await command({ op: "text" })).toEqual(STOPPED_ANSWERING);
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({
        ok: true,
        page: { title: "Owned fixture" },
      });
      expect(await command({ op: "text" })).toMatchObject({ ok: true });
    } finally {
      await close();
    }
  }, 60_000);

  it("survives closing a page that keeps opening dialogs, and other threads go on", async () => {
    const { panes, close } = headlessPanes({
      executable: executable!,
      sandbox: false,
      deadlineMs: 3_000,
    });
    try {
      const command = (threadId: string, input: PaneCommand) =>
        panes.serve({ threadId, limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command("other", { op: "navigate", url: `${origin}/` })).toMatchObject({
        ok: true,
      });
      expect(await command("owned", { op: "navigate", url: `${origin}/` })).toMatchObject({
        ok: true,
      });
      await command("owned", {
        op: "evaluate",
        expression: "setInterval(() => alert(1), 0); 1",
      });
      await command("owned", { op: "navigate", url: `${origin}/next` });
      await command("owned", { op: "evaluate", expression: "1" });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // The browser is still there: the other thread's page answers, and this one opens afresh.
      const other = await command("other", { op: "evaluate", expression: "document.title" });
      expect(other.ok && other.content).toContain("Owned fixture");
      expect(await command("owned", { op: "navigate", url: `${origin}/` })).toMatchObject({
        ok: true,
        page: { title: "Owned fixture" },
      });
    } finally {
      await close();
    }
  }, 90_000);

  it("leaves a command waiting its turn alone while the one before it runs", async () => {
    const { panes, close } = headlessPanes({
      executable: executable!,
      sandbox: false,
      deadlineMs: 3_000,
    });
    try {
      const command = (input: PaneCommand) =>
        panes.serve({ threadId: "owned", limits: { actOnLoopbackOnly: false }, command: input });
      expect(await command({ op: "navigate", url: `${origin}/` })).toMatchObject({ ok: true });
      const results = await Promise.all([
        command({
          op: "evaluate",
          expression: "new Promise((done) => setTimeout(() => done(1), 2000))",
        }),
        command({
          op: "evaluate",
          expression: "new Promise((done) => setTimeout(() => done(2), 2000))",
        }),
      ]);
      expect(results.map((result) => result.ok)).toEqual([true, true]);
    } finally {
      await close();
    }
  }, 60_000);

  it("starts the browser with none of this process's other variables", async () => {
    process.env["GRAM_TEST_INVENTED_SECRET"] = "invented";
    const browser = launchHeadless({ executable: executable!, sandbox: false });
    try {
      const { processInfo } = (await browser.connection.send("SystemInfo.getProcessInfo")) as {
        processInfo: Array<{ type: string; id: number }>;
      };
      const pid = processInfo.find((entry) => entry.type === "browser")?.id;
      expect(pid).toBeTypeOf("number");
      const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
      expect(environ).not.toContain("GRAM_TEST_INVENTED_SECRET");
      expect(environ).not.toContain("NODE_OPTIONS");
    } finally {
      delete process.env["GRAM_TEST_INVENTED_SECRET"];
      await browser.close();
    }
  }, 60_000);
});

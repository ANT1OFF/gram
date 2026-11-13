// Agents' pages in a headless Chromium, for a Gram that runs without the desktop app (the Docker
// image, a server on its own). The same pane module (`pane.ts`) drives them; this file gives it
// each thread's page as `PaneContents`, over the DevTools Protocol on a pipe, and stands in for
// the desktop Preview's request checks.
//
// This first version reaches loopback only. The browser starts with every connection sent to a
// closed proxy, which Chromium skips only for loopback, so a page here can't reach the internet or
// the private network whatever a check below decides. Each request is also paused and put to the
// pane's own rules first (`AgentPanes.navigation` and `request`), as the desktop shell does.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import { previewNavigation, previewRequest } from "../../core/preview-rules.ts";
import type { PreviewRequestDetails } from "../preview/main.ts";
import type { PaneContents, PaneViews } from "./pane.ts";

// ---------------------------------------------------------------------------------------------
// The protocol connection.

/** One DevTools Protocol connection to the browser; `sessionId` addresses an attached page. */
export interface CdpConnection {
  send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  /** Every event, with the session it came from; returns the unsubscribe function. */
  on(
    listener: (method: string, params: unknown, sessionId: string | undefined) => void,
  ): () => void;
  /** Called once when the connection ends, by `close` or the browser going away. */
  onClose(listener: () => void): void;
  close(): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/**
 * A connection over Chromium's `--remote-debugging-pipe`: JSON messages, each ended by a NUL, on
 * the child's fourth and fifth file descriptors.
 */
export const pipeConnection = (write: Writable, read: Readable): CdpConnection => {
  let next = 1;
  let closed = false;
  const pending = new Map<number, Pending>();
  const listeners = new Set<(method: string, params: unknown, sessionId?: string) => void>();
  const closers: Array<() => void> = [];
  let buffer = "";
  const end = () => {
    if (closed) return;
    closed = true;
    for (const { reject } of pending.values()) reject(new Error("The browser closed."));
    pending.clear();
    for (const closer of closers) closer();
  };
  read.setEncoding("utf8");
  read.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\0");
    while (at !== -1) {
      const raw = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\0");
      let message: {
        id?: number;
        method?: string;
        params?: unknown;
        sessionId?: string;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (waiting === undefined) continue;
        if (message.error !== undefined)
          waiting.reject(new Error(message.error.message ?? "The browser refused the command."));
        else waiting.resolve(message.result ?? {});
      } else if (message.method !== undefined) {
        for (const listener of Array.from(listeners))
          listener(message.method, message.params, message.sessionId);
      }
    }
  });
  read.on("close", end);
  read.on("error", end);
  write.on("error", end);
  return {
    send: (method, params, sessionId) => {
      if (closed) return Promise.reject(new Error("The browser closed."));
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write.write(
          `${JSON.stringify({ id, method, params: params ?? {}, ...(sessionId === undefined ? {} : { sessionId }) })}\0`,
        );
      });
    },
    on: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: (listener) => {
      if (closed) listener();
      else closers.push(listener);
    },
    close: () => {
      write.end();
      end();
    },
  };
};

// ---------------------------------------------------------------------------------------------
// The browser.

/** The flags the headless browser starts with. */
export const headlessArgs = (userDataDir: string, sandbox: boolean): Array<string> => [
  "--headless=new",
  "--remote-debugging-pipe",
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-extensions",
  "--metrics-recording-only",
  "--mute-audio",
  // Every frame in the page's own process, so the page's paused requests are all of them.
  "--disable-site-isolation-trials",
  "--disable-features=IsolateOrigins,site-per-process",
  // Everything but loopback goes to a closed port and fails: Chromium always sends loopback
  // direct, so this is the only network a page here has.
  "--proxy-server=http://127.0.0.1:9",
  ...(sandbox ? [] : ["--no-sandbox"]),
  "about:blank",
];

export interface HeadlessBrowser {
  readonly connection: CdpConnection;
  /** Ends the browser; settles once it has stopped and its profile is gone. */
  close(): Promise<void>;
}

/**
 * Starts `executable` headless, in a profile of its own under the temp folder, with no sandbox
 * only when `sandbox` is false (root in a container, where Chromium refuses one).
 */
export const launchHeadless = (options: {
  readonly executable: string;
  readonly sandbox: boolean;
}): HeadlessBrowser => {
  const userDataDir = mkdtempSync(join(tmpdir(), "gram-headless-"));
  const child: ChildProcess = spawn(
    options.executable,
    headlessArgs(userDataDir, options.sandbox),
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    },
  );
  const [, , , toBrowser, fromBrowser] = child.stdio as unknown as [
    null,
    null,
    null,
    Writable,
    Readable,
  ];
  const connection = pipeConnection(toBrowser, fromBrowser);
  // The profile goes once the browser has stopped writing to it.
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Left in the temp folder, which the system clears.
      }
      resolve();
    };
    child.once("exit", done);
    child.once("error", done);
  });
  void exited.then(() => connection.close());
  return {
    connection,
    close: () => {
      connection.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      return exited;
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Each thread's page.

/**
 * The pane's checks, which decide first; `undefined` leaves a request to the desktop Preview's own
 * local-session rules (`previewNavigation`, `previewRequest`): loopback and the page's own data.
 */
export interface HeadlessGate {
  navigation(contents: PaneContents, url: string): "load" | "block" | undefined;
  request(
    contents: PaneContents,
    details: PreviewRequestDetails,
  ): Promise<"allow" | "block"> | undefined;
}

const originOf = (url: string): string | undefined => {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

interface PausedRequest {
  readonly requestId: string;
  readonly request: { readonly url: string; readonly method: string };
  readonly frameId: string;
  readonly resourceType: string;
  readonly networkId?: string;
}

interface FrameEvent {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly url: string;
    readonly urlFragment?: string;
  };
}

/**
 * One thread's page: a target in a browser context of its own, so threads share no cookies or
 * storage. `gate` is asked about every request before it goes. The returned contents are ready to
 * use; `debugger` is a second session the pane attaches and detaches as it likes.
 */
export const openHeadlessPage = async (
  connection: CdpConnection,
  gate: () => HeadlessGate | undefined,
): Promise<PaneContents> => {
  const { browserContextId } = (await connection.send("Target.createBrowserContext", {
    disposeOnDetach: true,
  })) as { browserContextId: string };
  const { targetId } = (await connection.send("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  })) as { targetId: string };
  const { sessionId: own } = (await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })) as { sessionId: string };

  const events = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  let url = "";
  let title = "";
  let loading = false;
  let destroyed = false;
  let mainFrameId: string | undefined;
  let history: { currentIndex: number; entries: Array<{ id: number }> } = {
    currentIndex: 0,
    entries: [],
  };
  /** The address `loadURL` asked for, whose request is the app's own and not the page's. */
  let appLoad: string | undefined;
  /** A request's number across its redirects, by the browser's network id. */
  const ids = new Map<string, number>();
  let nextId = 1;
  let debuggerSession: string | undefined;
  let attaching: Promise<string> | undefined;

  const ownSend = (method: string, params?: object) => connection.send(method, params, own);
  const refreshHistory = () => {
    void ownSend("Page.getNavigationHistory")
      .then((value) => {
        history = value as typeof history;
      })
      .catch(() => {});
  };
  const refreshTitle = () =>
    connection
      .send("Target.getTargetInfo", { targetId })
      .then((value) => {
        title = (value as { targetInfo: { title: string } }).targetInfo.title;
      })
      .catch(() => {});

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    loading = false;
    debuggerSession = undefined;
    debuggerEvents.emit("detach");
    events.emit("destroyed");
    unsubscribe();
  };

  const contents: PaneContents = {
    getURL: () => url,
    getTitle: () => title,
    isDestroyed: () => destroyed,
    isLoading: () => loading,
    loadURL: async (target) => {
      if (destroyed) throw new Error("The page closed.");
      appLoad = target;
      const result = (await ownSend("Page.navigate", { url: target })) as { errorText?: string };
      if (result.errorText !== undefined && result.errorText !== "")
        throw new Error(result.errorText);
    },
    navigationHistory: {
      canGoBack: () => history.currentIndex > 0,
      goBack: () => {
        const entry = history.entries[history.currentIndex - 1];
        if (entry !== undefined)
          void ownSend("Page.navigateToHistoryEntry", { entryId: entry.id }).catch(() => {});
      },
    },
    debugger: {
      attach: () => {
        if (attaching !== undefined || destroyed) return;
        attaching = connection
          .send("Target.attachToTarget", { targetId, flatten: true })
          .then((value) => {
            debuggerSession = (value as { sessionId: string }).sessionId;
            return debuggerSession;
          });
        attaching.catch(() => {
          attaching = undefined;
        });
      },
      isAttached: () => attaching !== undefined && !destroyed,
      detach: () => {
        const session = debuggerSession;
        attaching = undefined;
        debuggerSession = undefined;
        if (session !== undefined)
          void connection.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
        debuggerEvents.emit("detach");
      },
      sendCommand: async (method, params) => {
        if (attaching === undefined) throw new Error("The debugger isn't attached.");
        const session = await attaching;
        const result = await connection.send(method, params, session);
        // A page's script retitles it without an event, so the title is read again after each
        // command, ready for the result the pane builds next.
        await refreshTitle();
        return result;
      },
      on: (event: string, listener: (...args: never[]) => void) =>
        debuggerEvents.on(event, listener as (...args: unknown[]) => void),
      off: (event: string, listener: (...args: never[]) => void) =>
        debuggerEvents.off(event, listener as (...args: unknown[]) => void),
    } as PaneContents["debugger"],
    on: ((event: string, listener: (...args: never[]) => void) =>
      events.on(event, listener as (...args: unknown[]) => void)) as PaneContents["on"],
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
  };

  const decide = async (paused: PausedRequest): Promise<"allow" | "block"> => {
    const { request, frameId, resourceType } = paused;
    const document = resourceType === "Document";
    const mainFrame = document && (mainFrameId === undefined || frameId === mainFrameId);
    const app = mainFrame && appLoad !== undefined && request.url === appLoad;
    if (mainFrame) appLoad = undefined;
    const key = paused.networkId ?? paused.requestId;
    let id = ids.get(key);
    if (id === undefined) {
      id = nextId++;
      ids.set(key, id);
      if (ids.size > 512) ids.delete(ids.keys().next().value!);
    }
    const rules = gate();
    if (mainFrame) {
      const verdict = rules?.navigation(contents, request.url);
      if (verdict === "block") return "block";
      if (verdict === undefined && previewNavigation(request.url) !== "load") return "block";
      events.emit("did-start-navigation", {
        url: request.url,
        isMainFrame: true,
        isSameDocument: false,
      });
    }
    const initiator = app ? undefined : originOf(url);
    const details: PreviewRequestDetails = {
      id,
      url: request.url,
      method: request.method,
      mainFrame,
      subFrame: document && !mainFrame,
      ...(initiator === undefined ? {} : { initiator }),
    };
    const asked = rules?.request(contents, details);
    if (asked !== undefined) {
      const verdict = await asked;
      if (verdict === "block") return "block";
    }
    return previewRequest(request.url);
  };

  const unsubscribe = connection.on((method, params, sessionId) => {
    if (method === "Target.detachedFromTarget") {
      if ((params as { sessionId?: string }).sessionId === own) destroy();
      else if ((params as { sessionId?: string }).sessionId === debuggerSession) {
        debuggerSession = undefined;
        attaching = undefined;
        debuggerEvents.emit("detach");
      }
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const info = (params as { targetInfo?: { targetId?: string; title?: string } }).targetInfo;
      if (info?.targetId === targetId && typeof info.title === "string") title = info.title;
      return;
    }
    if (method === "Target.targetDestroyed") {
      if ((params as { targetId?: string }).targetId === targetId) destroy();
      return;
    }
    if (sessionId === debuggerSession && debuggerSession !== undefined) {
      debuggerEvents.emit("message", {}, method, params);
      return;
    }
    if (sessionId !== own) return;
    switch (method) {
      case "Fetch.requestPaused": {
        const paused = params as PausedRequest;
        void decide(paused)
          .catch((): "block" => "block")
          .then((verdict) =>
            verdict === "allow"
              ? ownSend("Fetch.continueRequest", { requestId: paused.requestId })
              : ownSend("Fetch.failRequest", {
                  requestId: paused.requestId,
                  errorReason: "BlockedByClient",
                }),
          )
          .catch(() => {});
        return;
      }
      case "Page.frameNavigated": {
        const { frame } = params as FrameEvent;
        if (frame.parentId !== undefined) return;
        mainFrameId = frame.id;
        url = `${frame.url}${frame.urlFragment ?? ""}`;
        refreshHistory();
        events.emit("did-navigate", {}, url);
        return;
      }
      case "Page.navigatedWithinDocument": {
        const event = params as { frameId: string; url: string };
        if (event.frameId !== mainFrameId) return;
        url = event.url;
        refreshHistory();
        return;
      }
      case "Page.frameStartedLoading": {
        if ((params as { frameId: string }).frameId === mainFrameId) loading = true;
        return;
      }
      case "Page.frameStoppedLoading": {
        if ((params as { frameId: string }).frameId !== mainFrameId) return;
        // The title first, so whoever waits on the load reads the page's own.
        void refreshTitle().then(() => {
          loading = false;
          events.emit("did-stop-loading");
        });
        return;
      }
      default:
    }
  });

  const { frameTree } = (await ownSend("Page.getFrameTree")) as {
    frameTree: { frame: { id: string; url: string } };
  };
  mainFrameId = frameTree.frame.id;
  url = frameTree.frame.url;
  await ownSend("Page.enable");
  await ownSend("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  refreshHistory();
  return contents;
};

/**
 * The pane's views in a headless browser: each thread's page made the first time a command asks
 * for it, in a browser context of its own. A page that couldn't be made is no page, and the next
 * command tries again.
 */
export const headlessViews = (
  connection: CdpConnection,
  gate: () => HeadlessGate | undefined,
  failed: (error: unknown) => void = () => {},
): PaneViews => {
  const pages = new Map<string, Promise<PaneContents | undefined>>();
  const openFor = (threadId: string) => {
    const made = openHeadlessPage(connection, gate).catch((error: unknown) => {
      failed(error);
      return undefined;
    });
    pages.set(threadId, made);
    return made;
  };
  return {
    contentsFor: (threadId, create) => {
      const known = pages.get(threadId);
      if (known !== undefined) {
        return known.then((page) => {
          if (page !== undefined && !page.isDestroyed()) return page;
          if (pages.get(threadId) === known) pages.delete(threadId);
          return create ? openFor(threadId) : undefined;
        });
      }
      return create ? openFor(threadId) : undefined;
    },
  };
};

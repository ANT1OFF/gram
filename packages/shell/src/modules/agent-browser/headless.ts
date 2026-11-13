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

import type { ViewInput } from "@gram/contracts/link-trust";

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
  // Everything but loopback goes to a closed port and fails. Chromium's own bypass covers
  // link-local addresses too (where a cloud's metadata service lives), so that one is taken away
  // (`<-loopback>`) and loopback alone is named.
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>;127.0.0.1;[::1];localhost",
  // WebRTC sends UDP past any proxy unless told to use the proxy or nothing.
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  // No name but loopback's resolves, so nothing a page writes leaves in a DNS query: WebRTC looks
  // up a candidate's or a TURN server's name itself, past the proxy.
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
  ...(sandbox ? [] : ["--no-sandbox"]),
  "about:blank",
];

export interface HeadlessBrowser {
  readonly connection: CdpConnection;
  /** Ends the browser; settles once it has stopped and its profile is gone. */
  close(): Promise<void>;
}

/** The variables the browser starts with: where it is, its locale and fonts, and nothing else. */
const BROWSER_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "FONTCONFIG_PATH",
  "FONTCONFIG_FILE",
] as const;

/** The browser's environment out of `env`: none of the server's tokens or debug switches. */
export const browserEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    BROWSER_ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );

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
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], env: browserEnv(process.env) },
  );
  const [, , , toBrowser, fromBrowser] = child.stdio as unknown as [
    null,
    null,
    null,
    Writable,
    Readable,
  ];
  const connection = pipeConnection(toBrowser, fromBrowser);
  // The profile goes once the browser has stopped writing to it; its helpers can outlive it by a
  // moment, so a removal that finds the folder still filling is tried again.
  const removeProfile = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  };
  const exited = new Promise<void>((resolve) => {
    let once = false;
    const done = () => {
      if (once) return;
      once = true;
      void removeProfile().then(resolve);
    };
    child.once("exit", done);
    child.once("error", done);
  });
  void exited.then(() => connection.close());
  const running = () => child.exitCode === null && child.signalCode === null;
  let closing = false;
  return {
    connection,
    close: () => {
      if (closing) return exited;
      closing = true;
      // Asked to close first, so it stops its own helpers; killed if it hasn't in two seconds.
      const asked = connection.send("Browser.close").catch(() => {});
      const kill = setTimeout(() => {
        if (running()) child.kill("SIGKILL");
      }, 2_000);
      void asked.then(() => connection.close());
      return exited.then(() => clearTimeout(kill));
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
  const held = await holdNewTargets(connection);
  const { browserContextId } = (await connection.send("Target.createBrowserContext", {
    disposeOnDetach: true,
  })) as { browserContextId: string };
  held.contexts.set(browserContextId, undefined);
  const dispose = () => {
    held.contexts.delete(browserContextId);
    held.waiting.delete(browserContextId);
    void connection.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
  };
  try {
    return await openIn(connection, gate, browserContextId, dispose, held);
  } catch (error) {
    dispose();
    throw error;
  }
};

/**
 * Run in every frame of a thread's page before its own scripts. It takes away what has no use on
 * a page that reaches loopback alone and that no person is looking at: WebRTC, and opening
 * windows. Neither is the guard: the browser's flags hold WebRTC to loopback, and a window that
 * opens all the same is closed with its requests failed (`holdNewTargets`).
 */
const PAGE_SETUP = `for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCDtlsTransport", "RTCSctpTransport"]) { try { delete globalThis[name]; } catch {} }
try { Object.defineProperty(globalThis, "open", { value: () => null, writable: false, configurable: false }); } catch {}`;

const ALL_REQUESTS = { patterns: [{ urlPattern: "*", requestStage: "Request" }] };

/** Pauses a worker's requests and lets through what the local rules do, then lets it start. */
const gateWorker = (connection: CdpConnection, sessionId: string) =>
  connection
    .send("Fetch.enable", ALL_REQUESTS, sessionId)
    .catch(() => {})
    .then(() => connection.send("Runtime.runIfWaitingForDebugger", {}, sessionId))
    .catch(() => {});

const answerWorker = (connection: CdpConnection, sessionId: string, params: unknown) => {
  const paused = params as PausedRequest;
  void (
    previewRequest(paused.request.url) === "allow"
      ? connection.send("Fetch.continueRequest", { requestId: paused.requestId }, sessionId)
      : connection.send(
          "Fetch.failRequest",
          { requestId: paused.requestId, errorReason: "BlockedByClient" },
          sessionId,
        )
  ).catch(() => {});
};

interface AttachedTarget {
  readonly sessionId: string;
  readonly targetId: string;
}

interface Held {
  /** Each thread's browser context, and its own page's target once `createTarget` has named it. */
  readonly contexts: Map<string, string | undefined>;
  /** The pages that attached in a context before its own page was named. */
  readonly waiting: Map<string, Array<AttachedTarget>>;
  /** Names the context's own page, and settles the pages that were waiting on it. */
  own(context: string, targetId: string): void;
}

const holding = new WeakMap<CdpConnection, Promise<Held>>();

/**
 * Has the browser hold every new target before it loads anything, once per connection. In a
 * thread's context the page `createTarget` made is the thread's own and starts; any other is a
 * window the page opened, which no command drives: it starts with its requests failed, since a
 * held window holds its opener's process too, and is closed. A navigation the browser had already
 * begun for it isn't caught, so its first request can reach loopback, and nothing further. A service or shared worker there
 * starts with its requests paused. Anything outside the threads' contexts (the browser's own
 * pages) just starts.
 */
const holdNewTargets = (connection: CdpConnection): Promise<Held> => {
  const known = holding.get(connection);
  if (known !== undefined) return known;
  const workers = new Set<string>();
  /** The sessions of windows being closed, none of whose requests go anywhere. */
  const doomed = new Set<string>();
  const release = (sessionId: string) =>
    void connection
      .send("Runtime.runIfWaitingForDebugger", {}, sessionId)
      .catch(() => {})
      .then(() => connection.send("Target.detachFromTarget", { sessionId }))
      .catch(() => {});
  const doom = ({ sessionId, targetId }: AttachedTarget) => {
    doomed.add(sessionId);
    void connection
      .send("Fetch.enable", ALL_REQUESTS, sessionId)
      .catch(() => {})
      .then(() => connection.send("Runtime.runIfWaitingForDebugger", {}, sessionId))
      .catch(() => {})
      .then(() => connection.send("Target.closeTarget", { targetId }))
      .catch(() => {});
  };
  const settle = (context: string, page: AttachedTarget) =>
    held.contexts.get(context) === page.targetId ? release(page.sessionId) : doom(page);
  const held: Held = {
    contexts: new Map(),
    waiting: new Map(),
    own: (context, targetId) => {
      held.contexts.set(context, targetId);
      const waiting = held.waiting.get(context) ?? [];
      held.waiting.delete(context);
      for (const page of waiting) settle(context, page);
    },
  };
  connection.on((method, params, sessionId) => {
    if (sessionId !== undefined) {
      if (method !== "Fetch.requestPaused") return;
      if (workers.has(sessionId)) answerWorker(connection, sessionId, params);
      else if (doomed.has(sessionId)) {
        void connection
          .send(
            "Fetch.failRequest",
            { requestId: (params as PausedRequest).requestId, errorReason: "BlockedByClient" },
            sessionId,
          )
          .catch(() => {});
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const gone = (params as { sessionId?: string }).sessionId ?? "";
      workers.delete(gone);
      doomed.delete(gone);
      return;
    }
    if (method !== "Target.attachedToTarget") return;
    const attached = params as {
      sessionId: string;
      waitingForDebugger?: boolean;
      targetInfo: { targetId: string; type: string; browserContextId?: string };
    };
    // Only what the browser attached by itself is held; a session this file asked for isn't.
    if (attached.waitingForDebugger !== true) return;
    const context = attached.targetInfo.browserContextId ?? "";
    if (!held.contexts.has(context)) return release(attached.sessionId);
    const target = { sessionId: attached.sessionId, targetId: attached.targetInfo.targetId };
    if (attached.targetInfo.type === "page") {
      if (held.contexts.get(context) !== undefined) return settle(context, target);
      // Its own page isn't named yet: this may be it, so it waits for `createTarget`'s answer.
      held.waiting.set(context, [...(held.waiting.get(context) ?? []), target]);
      return;
    }
    // Chromium's own helpers in the context (its UI pages, an extension's worker) just start.
    if (
      attached.targetInfo.type !== "service_worker" &&
      attached.targetInfo.type !== "shared_worker"
    )
      return release(attached.sessionId);
    workers.add(attached.sessionId);
    void gateWorker(connection, attached.sessionId);
  });
  const ready = connection
    .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    .then(() => held);
  holding.set(connection, ready);
  return ready;
};

/** How long a load the app asked for may take before it is stopped. */
export const LOAD_DEADLINE_MS = 30_000;

/** One frame of a page: a base64 JPEG, and the page's size in its own CSS pixels. */
export interface HeadlessFrame {
  readonly jpeg: string;
  readonly width: number;
  readonly height: number;
}

/** A page as someone watching it uses it: its frames, and a person's input to it. */
export interface HeadlessPage {
  /** Sends the page's frames as it repaints, the first at once; returns what stops them. */
  screencast(onFrame: (frame: HeadlessFrame) => void): () => void;
  /** Puts one pointer or key input into the page, as a person at it would. */
  input(input: ViewInput): Promise<void>;
  reload(): void;
  /** Whether there is a page behind this one: the blank one every page starts on isn't one. */
  canGoBack(): boolean;
  goForward(): void;
  canGoForward(): boolean;
}

/** The longest edge of a frame, in pixels: a larger page is sent scaled down. */
export const FRAME_EDGE = 1600;

/** The least time between two frames: twelve a second at most, whatever the page repaints. */
export const FRAME_INTERVAL_MS = 80;

const watched = new WeakMap<PaneContents, HeadlessPage>();

/** What watching a page `openHeadlessPage` made needs; `undefined` for any other contents. */
export const headlessPage = (contents: PaneContents): HeadlessPage | undefined =>
  watched.get(contents);

const MOUSE = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;

/** The DevTools Protocol's `Input` command for one input. */
export const inputCommand = (input: ViewInput): { method: string; params: object } => {
  if (input.type === "wheel") {
    const { x, y, deltaX, deltaY, modifiers } = input;
    return {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x, y, deltaX, deltaY, modifiers },
    };
  }
  if (input.type === "pointer") {
    const { x, y, button, buttons, clickCount, modifiers } = input;
    return {
      method: "Input.dispatchMouseEvent",
      params: { type: MOUSE[input.action], x, y, button, buttons, clickCount, modifiers },
    };
  }
  const { key, code, keyCode, text, modifiers } = input;
  const typed = input.action === "down" && text !== undefined;
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type: input.action === "up" ? "keyUp" : typed ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      modifiers,
      ...(typed ? { text, unmodifiedText: text } : {}),
      ...(input.repeat === true ? { autoRepeat: true } : {}),
    },
  };
};

/** Ends each page: its target, and the browser context that held its cookies and storage. */
const closers = new WeakMap<PaneContents, () => void>();

/** Closes a page `openHeadlessPage` made, with everything it stored. */
export const closeHeadlessPage = (contents: PaneContents): void => closers.get(contents)?.();

const openIn = async (
  connection: CdpConnection,
  gate: () => HeadlessGate | undefined,
  browserContextId: string,
  dispose: () => void,
  held: Held,
): Promise<PaneContents> => {
  const { targetId } = (await connection.send("Target.createTarget", {
    url: "about:blank",
    browserContextId,
  })) as { targetId: string };
  held.own(browserContextId, targetId);
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
  let history: { currentIndex: number; entries: Array<{ id: number; url?: string }> } = {
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

  /** Rejects when the page ends, so a command its renderer never answers ends with it. */
  const { promise: gone, reject: endGone } = Promise.withResolvers<never>();
  gone.catch(() => {});
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    endGone(new Error("The page closed."));
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
      // A server that never answers would hold the thread's commands for good.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          void ownSend("Page.stopLoading").catch(() => {});
          reject(new Error("The page didn't answer in time."));
        }, LOAD_DEADLINE_MS);
      });
      try {
        const result = (await Promise.race([
          ownSend("Page.navigate", { url: target }),
          late,
          gone,
        ])) as {
          errorText?: string;
        };
        if (result.errorText !== undefined && result.errorText !== "")
          throw new Error(result.errorText);
      } finally {
        clearTimeout(deadline);
        if (appLoad === target) appLoad = undefined;
      }
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
        // Not for a page that is ending: its sessions go with its target, and a detach sent into
        // a page stuck behind its own dialogs has brought the whole browser down.
        if (session !== undefined && !destroyed)
          void connection.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
        debuggerEvents.emit("detach");
      },
      sendCommand: async (method, params) => {
        if (attaching === undefined) throw new Error("The debugger isn't attached.");
        const session = await attaching;
        const result = await Promise.race([connection.send(method, params, session), gone]);
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

  /** Who gets the page's frames now; one watcher at a time. */
  let onFrame: ((frame: HeadlessFrame) => void) | undefined;
  let lastFrameAt = 0;
  let focused = false;
  watched.set(contents, {
    screencast: (listener) => {
      onFrame = listener;
      if (!destroyed)
        void ownSend("Page.startScreencast", {
          format: "jpeg",
          quality: 70,
          maxWidth: FRAME_EDGE,
          maxHeight: FRAME_EDGE,
        }).catch(() => {});
      return () => {
        if (onFrame !== listener) return;
        onFrame = undefined;
        if (!destroyed) void ownSend("Page.stopScreencast").catch(() => {});
      };
    },
    input: async (input) => {
      if (destroyed) return;
      if (!focused) {
        // Keys go to a page that believes it has the focus, which no headless page has by itself.
        focused = true;
        await ownSend("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      }
      const { method, params } = inputCommand(input);
      await Promise.race([ownSend(method, params), gone]).catch(() => {});
      // What the input did may have retitled the page, which no event says.
      if (input.type !== "pointer" || input.action === "up") await refreshTitle();
    },
    reload: () => {
      if (!destroyed) void ownSend("Page.reload").catch(() => {});
    },
    goForward: () => {
      const entry = history.entries[history.currentIndex + 1];
      if (entry !== undefined && !destroyed)
        void ownSend("Page.navigateToHistoryEntry", { entryId: entry.id }).catch(() => {});
    },
    canGoBack: () =>
      history.currentIndex > 0 && history.entries[history.currentIndex - 1]?.url !== "about:blank",
    canGoForward: () => history.currentIndex < history.entries.length - 1,
  });

  /** `stay` stops a navigation the page itself started and keeps the document it is on. */
  const decide = async (paused: PausedRequest): Promise<"allow" | "block" | "stay"> => {
    const verdict = await judge(paused);
    if (verdict === "allow") return "allow";
    const { frameId, resourceType } = paused;
    const mainFrame =
      resourceType === "Document" && (mainFrameId === undefined || frameId === mainFrameId);
    return mainFrame && !appLoads.delete(paused.requestId) ? "stay" : "block";
  };
  /** The sessions of what the page started (workers), whose requests are paused too. */
  const children = new Set<string>();
  /** The paused requests that were the app's own load, which fail loudly so `loadURL` hears. */
  const appLoads = new Set<string>();
  const judge = async (paused: PausedRequest): Promise<"allow" | "block"> => {
    const { request, frameId, resourceType } = paused;
    const document = resourceType === "Document";
    const mainFrame = document && (mainFrameId === undefined || frameId === mainFrameId);
    const app = mainFrame && appLoad !== undefined && request.url === appLoad;
    if (mainFrame) appLoad = undefined;
    if (app) appLoads.add(paused.requestId);
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
      children.delete((params as { sessionId?: string }).sessionId ?? "");
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
    if (sessionId !== undefined && children.has(sessionId)) {
      // A worker's own request, which the page's session never sees: the local rules alone.
      if (method === "Fetch.requestPaused") answerWorker(connection, sessionId, params);
      return;
    }
    if (sessionId !== own) return;
    switch (method) {
      case "Target.attachedToTarget": {
        // What the page starts inside itself (a worker) is held too, and runs with its requests
        // paused like the page's.
        const attached = params as { sessionId: string };
        children.add(attached.sessionId);
        void gateWorker(connection, attached.sessionId);
        return;
      }
      case "Fetch.requestPaused": {
        const paused = params as PausedRequest;
        void decide(paused)
          .catch((): "block" => "block")
          .then((verdict) => {
            appLoads.delete(paused.requestId);
            if (verdict === "allow")
              return ownSend("Fetch.continueRequest", { requestId: paused.requestId });
            // No content: the navigation ends and the page stays where it was, as a stopped
            // navigation does in the desktop app, where failing it would leave an error page.
            if (verdict === "stay")
              return ownSend("Fetch.fulfillRequest", {
                requestId: paused.requestId,
                responseCode: 204,
              });
            return ownSend("Fetch.failRequest", {
              requestId: paused.requestId,
              errorReason: "BlockedByClient",
            });
          })
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
      case "Page.javascriptDialogOpening": {
        // Nobody is here to answer a dialog, and an open one stops every command: an alert,
        // confirm or prompt is dismissed, and a page is let leave.
        void ownSend("Page.handleJavaScriptDialog", {
          accept: (params as { type?: string }).type === "beforeunload",
        }).catch(() => {});
        return;
      }
      case "Page.screencastFrame": {
        const frame = params as {
          data: string;
          sessionId: number;
          metadata: { deviceWidth: number; deviceHeight: number };
        };
        onFrame?.({
          jpeg: frame.data,
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
        });
        // The browser sends the next frame once this one is acknowledged, so a late answer is
        // what paces a page that repaints all the time.
        const wait = Math.max(0, lastFrameAt + FRAME_INTERVAL_MS - Date.now());
        lastFrameAt = Date.now() + wait;
        setTimeout(() => {
          if (!destroyed)
            void ownSend("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        }, wait);
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
  await ownSend("Fetch.enable", ALL_REQUESTS);
  await ownSend("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SETUP });
  // No page is loaded ahead of a navigation: such a load is the browser's own, and isn't paused.
  await ownSend("Page.setPrerenderingAllowed", { isAllowed: false }).catch(() => {});
  await ownSend("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  refreshHistory();
  closers.set(contents, () => {
    // Ended for the pane first, so nothing more is sent to a page on its way out.
    destroy();
    void connection.send("Target.closeTarget", { targetId }).catch(() => {});
    dispose();
  });
  // A browser that died takes its pages with it: the next command starts another.
  connection.onClose(destroy);
  return contents;
};

/** How many threads keep a page at once; the one used longest ago closes for the next. */
export const HEADLESS_PAGE_LIMIT = 4;

/**
 * The pane's views in a headless browser: each thread's page made the first time a command asks
 * for it, in a browser context of its own. A page that couldn't be made is no page, and the next
 * command tries again. At most `HEADLESS_PAGE_LIMIT` threads keep a page, as the desktop Preview
 * keeps four: the one whose last command (`touch`) is oldest closes to make room, and `closed` hears
 * of it. `close` ends a thread's page with what it stored; the next command makes a new one.
 */
export const headlessViews = (
  connection: CdpConnection,
  gate: () => HeadlessGate | undefined,
  failed: (error: unknown) => void = () => {},
  closed: (threadId: string) => void = () => {},
  /** Whether a command is running on the thread's page, which is then never the one closed. */
  busy: (threadId: string) => boolean = () => false,
): PaneViews & {
  touch(threadId: string): void;
  close(threadId: string): Promise<void>;
  /** The thread's page if it has one, without counting as a use of it. */
  peek(threadId: string): Promise<PaneContents | undefined>;
} => {
  // In order of use, the least recent first.
  const pages = new Map<string, Promise<PaneContents | undefined>>();
  const touch = (threadId: string) => {
    const page = pages.get(threadId);
    if (page === undefined) return;
    pages.delete(threadId);
    pages.set(threadId, page);
  };
  const openFor = (threadId: string) => {
    for (const [other, page] of Array.from(pages)) {
      if (pages.size < HEADLESS_PAGE_LIMIT) break;
      if (busy(other)) continue;
      pages.delete(other);
      void page.then((contents) => {
        if (contents !== undefined) closeHeadlessPage(contents);
        closed(other);
      });
    }
    const made = openHeadlessPage(connection, gate).catch((error: unknown) => {
      failed(error);
      return undefined;
    });
    pages.set(threadId, made);
    return made;
  };
  return {
    touch,
    peek: async (threadId) => {
      const page = await pages.get(threadId);
      return page === undefined || page.isDestroyed() ? undefined : page;
    },
    close: async (threadId) => {
      const page = pages.get(threadId);
      if (page === undefined) return;
      pages.delete(threadId);
      const contents = await page;
      if (contents !== undefined) closeHeadlessPage(contents);
    },
    contentsFor: (threadId, create) => {
      const known = pages.get(threadId);
      if (known !== undefined) {
        touch(threadId);
        return known.then((page) => {
          if (page !== undefined && !page.isDestroyed()) return page;
          // What a page that ended by itself stored goes with it.
          if (page !== undefined) closeHeadlessPage(page);
          if (pages.get(threadId) === known) pages.delete(threadId);
          return create ? openFor(threadId) : undefined;
        });
      }
      return create ? openFor(threadId) : undefined;
    },
  };
};

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { fieldsOf } from "@gram/contracts";
import type { ViewInput } from "@gram/contracts/link-trust";

import { previewNavigation, previewRequest } from "../../core/preview-rules.ts";
import type { PreviewRequestDetails } from "../preview/main.ts";
import {
  cdpEvent,
  cdpResult,
  cdpSend,
  type NavigationHistory,
  type PausedRequest,
} from "./cdp-protocol.ts";
import type { PaneContents, PaneViews } from "./pane.ts";
import { setTimeout as sleep } from "node:timers/promises";

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
      let message: ReadonlyMap<string, unknown>;
      try {
        message = fieldsOf(JSON.parse(raw));
      } catch {
        continue;
      }
      const id = message.get("id");
      const method = message.get("method");
      if (typeof id === "number") {
        const waiting = pending.get(id);
        pending.delete(id);
        if (waiting === undefined) continue;
        const error = message.get("error");
        if (error !== undefined) {
          const why = fieldsOf(error).get("message");
          waiting.reject(
            new Error(typeof why === "string" ? why : "The browser refused the command."),
          );
        } else waiting.resolve(message.get("result") ?? {});
      } else if (typeof method === "string") {
        const sessionId = message.get("sessionId");
        for (const listener of Array.from(listeners))
          listener(
            method,
            message.get("params"),
            typeof sessionId === "string" ? sessionId : undefined,
          );
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
  "--disable-site-isolation-trials",
  "--disable-features=IsolateOrigins,site-per-process",
  "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=<-loopback>;127.0.0.1;[::1];localhost",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]",
  ...(sandbox ? [] : ["--no-sandbox"]),
  "about:blank",
];

export interface HeadlessBrowser {
  readonly connection: CdpConnection;
  /** Ends the browser; settles once it has stopped and its profile is gone. */
  close(): Promise<void>;
}

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
  const [, , , toBrowser, fromBrowser] = child.stdio;
  if (!isWritable(toBrowser) || !isReadable(fromBrowser))
    throw new Error("The browser's DevTools pipes didn't open.");
  const connection = pipeConnection(toBrowser, fromBrowser);
  const removeProfile = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        return;
      } catch {
        await sleep(200);
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
      const asked = connection.send("Browser.close").catch(() => {});
      const kill = setTimeout(() => {
        if (running()) child.kill("SIGKILL");
      }, 2_000);
      void asked.then(() => connection.close());
      return exited.then(() => clearTimeout(kill));
    },
  };
};

/** A proxy a page's loopback may go to: a SOCKS5 listener on this machine's own IPv4 loopback. */
export const isLoopbackProxy = (proxy: string): boolean =>
  /^socks5:\/\/127\.0\.0\.1:\d{1,5}$/.test(proxy);

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

/**
 * One thread's page: a target in a browser context of its own, so threads share no cookies or
 * storage. `gate` is asked about every request before it goes. The returned contents are ready to
 * use; `debugger` is a second session the pane attaches and detaches as it likes.
 */
export const openHeadlessPage = async (
  connection: CdpConnection,
  gate: () => HeadlessGate | undefined,
  loopbackProxy?: string,
): Promise<PaneContents> => {
  const held = await holdNewTargets(connection);
  const { browserContextId } = await cdpSend(connection, "Target.createBrowserContext", {
    disposeOnDetach: true,
    ...(loopbackProxy !== undefined && isLoopbackProxy(loopbackProxy)
      ? { proxyServer: loopbackProxy, proxyBypassList: "<-loopback>" }
      : {}),
  });
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

const PAGE_SETUP = `for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceTransport", "RTCDtlsTransport", "RTCSctpTransport"]) { try { delete globalThis[name]; } catch {} }
try { Object.defineProperty(globalThis, "open", { value: () => null, writable: false, configurable: false }); } catch {}`;

const ALL_REQUESTS = { patterns: [{ urlPattern: "*", requestStage: "Request" }] };

const gateWorker = (connection: CdpConnection, sessionId: string) =>
  connection
    .send("Fetch.enable", ALL_REQUESTS, sessionId)
    .catch(() => {})
    .then(() => connection.send("Runtime.runIfWaitingForDebugger", {}, sessionId))
    .catch(() => {});

const isWritable = (stream: unknown): stream is Writable => stream instanceof Writable;
const isReadable = (stream: unknown): stream is Readable => stream instanceof Readable;

const answerWorker = (connection: CdpConnection, sessionId: string, params: unknown) => {
  const paused = cdpEvent("Fetch.requestPaused", params);
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
  readonly contexts: Map<string, string | undefined>;
  readonly waiting: Map<string, Array<AttachedTarget>>;
  own(context: string, targetId: string): void;
}

const holding = new WeakMap<CdpConnection, Promise<Held>>();

const holdNewTargets = (connection: CdpConnection): Promise<Held> => {
  const known = holding.get(connection);
  if (known !== undefined) return known;
  const workers = new Set<string>();
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
            {
              requestId: cdpEvent("Fetch.requestPaused", params).requestId,
              errorReason: "BlockedByClient",
            },
            sessionId,
          )
          .catch(() => {});
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const gone = cdpEvent(method, params).sessionId ?? "";
      workers.delete(gone);
      doomed.delete(gone);
      return;
    }
    if (method !== "Target.attachedToTarget") return;
    const attached = cdpEvent(method, params);
    if (attached.waitingForDebugger !== true) return;
    const context = attached.targetInfo.browserContextId ?? "";
    const target = { sessionId: attached.sessionId, targetId: attached.targetInfo.targetId };
    const own = /^(devtools|chrome|chrome-untrusted):/.test(attached.targetInfo.url ?? "");
    if (own || (!held.contexts.has(context) && attached.targetInfo.type === "page"))
      return doom(target);
    if (!held.contexts.has(context)) return release(attached.sessionId);
    if (attached.targetInfo.type === "page") {
      if (held.contexts.get(context) !== undefined) return settle(context, target);
      held.waiting.set(context, [...(held.waiting.get(context) ?? []), target]);
      return;
    }
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
  /** Releases what the person still holds in the page: a mouse button, keys, the focus. */
  letGo(): void;
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

const real = (entry: { url?: string } | undefined): boolean =>
  entry !== undefined && entry.url !== "about:blank";

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
  const { targetId } = await cdpSend(connection, "Target.createTarget", {
    url: "about:blank",
    browserContextId,
  });
  held.own(browserContextId, targetId);
  const { sessionId: own } = await cdpSend(connection, "Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  const events = new EventEmitter();
  const debuggerEvents = new EventEmitter();
  let url = "";
  let title = "";
  let loading = false;
  let destroyed = false;
  let mainFrameId: string | undefined;
  let history: NavigationHistory = {
    currentIndex: 0,
    entries: [],
  };
  let appLoad: string | undefined;
  const ids = new Map<string, number>();
  let nextId = 1;
  let debuggerSession: string | undefined;
  let attaching: Promise<string> | undefined;

  const ownSend = (method: string, params?: object) => connection.send(method, params, own);
  const readHistory = () =>
    cdpSend(connection, "Page.getNavigationHistory", undefined, own).then((value) => {
      history = value;
      return history;
    });
  const refreshHistory = () => {
    void readHistory().catch(() => {});
  };
  const step = (by: -1 | 1) => {
    if (destroyed) return;
    void readHistory()
      .then(({ entries, currentIndex }) => {
        const entry = entries[currentIndex + by];
        if (real(entry)) return ownSend("Page.navigateToHistoryEntry", { entryId: entry!.id });
        return undefined;
      })
      .catch(() => {});
  };
  const refreshTitle = () =>
    connection
      .send("Target.getTargetInfo", { targetId })
      .then((value) => {
        title = cdpResult("Target.getTargetInfo", value).targetInfo.title;
      })
      .catch(() => {});

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
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          void ownSend("Page.stopLoading").catch(() => {});
          reject(new Error("The page didn't answer in time."));
        }, LOAD_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([
          cdpSend(connection, "Page.navigate", { url: target }, own),
          late,
          gone,
        ]);
        if (result.errorText !== undefined && result.errorText !== "")
          throw new Error(result.errorText);
      } finally {
        clearTimeout(deadline);
        if (appLoad === target) appLoad = undefined;
      }
    },
    navigationHistory: {
      canGoBack: () => real(history.entries[history.currentIndex - 1]),
      goBack: () => step(-1),
    },
    debugger: {
      attach: () => {
        if (attaching !== undefined || destroyed) return;
        attaching = connection
          .send("Target.attachToTarget", { targetId, flatten: true })
          .then((value) => {
            debuggerSession = cdpResult("Target.attachToTarget", value).sessionId;
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
        if (session !== undefined && !destroyed)
          void connection.send("Target.detachFromTarget", { sessionId: session }).catch(() => {});
        debuggerEvents.emit("detach");
      },
      sendCommand: async (method, params) => {
        if (attaching === undefined) throw new Error("The debugger isn't attached.");
        const session = await attaching;
        const result = await Promise.race([connection.send(method, params, session), gone]);
        await refreshTitle();
        return result;
      },
      on: (event: string, listener: (...args: never[]) => void) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an EventEmitter listener takes whatever its event emits, which is what each event names
        debuggerEvents.on(event, listener as (...args: unknown[]) => void),
      off: (event: string, listener: (...args: never[]) => void) =>
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same listener `on` was given
        debuggerEvents.off(event, listener as (...args: unknown[]) => void),
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- WebContents' `on` is overloaded per event; this one emitter serves them all
    on: ((event: string, listener: (...args: never[]) => void) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an EventEmitter listener takes whatever its event emits, which is what each event names
      events.on(event, listener as (...args: unknown[]) => void)) as PaneContents["on"],
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
  };

  let onFrame: ((frame: HeadlessFrame) => void) | undefined;
  let lastFrameAt = 0;
  let focused = false;
  const heldKeys = new Map<number, object>();
  let heldButton: { x: number; y: number; button: string; clickCount: number } | undefined;
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
        focused = true;
        await ownSend("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
      }
      const { method, params } = inputCommand(input);
      if (input.type === "key") {
        if (input.action === "up") heldKeys.delete(input.keyCode);
        else if (heldKeys.size < 16 || heldKeys.has(input.keyCode)) {
          const { key, code, keyCode } = input;
          heldKeys.set(keyCode, {
            key,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
          });
        }
      } else if (input.type === "pointer" && input.action !== "move") {
        const { x, y, button } = input;
        heldButton = input.action === "down" ? { x, y, button, clickCount: 1 } : undefined;
      } else if (input.type === "pointer" && heldButton !== undefined) {
        heldButton = { ...heldButton, x: input.x, y: input.y };
      }
      await Promise.race([ownSend(method, params), gone]).catch(() => {});
      if (input.type !== "pointer" || input.action === "up") await refreshTitle();
    },
    reload: () => {
      if (!destroyed) void ownSend("Page.reload").catch(() => {});
    },
    goForward: () => step(1),
    canGoBack: () => real(history.entries[history.currentIndex - 1]),
    canGoForward: () => history.currentIndex < history.entries.length - 1,
    letGo: () => {
      if (destroyed) return;
      const keys = Array.from(heldKeys.values());
      heldKeys.clear();
      for (const key of keys)
        void ownSend("Input.dispatchKeyEvent", { ...key, type: "keyUp" }).catch(() => {});
      if (heldButton !== undefined) {
        void ownSend("Input.dispatchMouseEvent", {
          ...heldButton,
          type: "mouseReleased",
          buttons: 0,
        }).catch(() => {});
        heldButton = undefined;
      }
      if (focused) {
        focused = false;
        void ownSend("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
      }
    },
  });

  const decide = async (paused: PausedRequest): Promise<"allow" | "block" | "stay"> => {
    const verdict = await judge(paused);
    if (verdict === "allow") return "allow";
    const { frameId, resourceType } = paused;
    const mainFrame =
      resourceType === "Document" && (mainFrameId === undefined || frameId === mainFrameId);
    return mainFrame && !appLoads.delete(paused.requestId) ? "stay" : "block";
  };
  const children = new Set<string>();
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
      const { sessionId: detached } = cdpEvent(method, params);
      children.delete(detached ?? "");
      if (detached === own) destroy();
      else if (detached === debuggerSession) {
        debuggerSession = undefined;
        attaching = undefined;
        debuggerEvents.emit("detach");
      }
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const info = cdpEvent(method, params).targetInfo;
      if (info?.targetId === targetId && typeof info.title === "string") title = info.title;
      return;
    }
    if (method === "Target.targetDestroyed") {
      if (cdpEvent(method, params).targetId === targetId) destroy();
      return;
    }
    if (sessionId === debuggerSession && debuggerSession !== undefined) {
      debuggerEvents.emit("message", {}, method, params);
      return;
    }
    if (sessionId !== undefined && children.has(sessionId)) {
      if (method === "Fetch.requestPaused") answerWorker(connection, sessionId, params);
      return;
    }
    if (sessionId !== own) return;
    switch (method) {
      case "Target.attachedToTarget": {
        const attached = cdpEvent(method, params);
        children.add(attached.sessionId);
        void gateWorker(connection, attached.sessionId);
        return;
      }
      case "Fetch.requestPaused": {
        const paused = cdpEvent(method, params);
        void decide(paused)
          .catch((): "block" => "block")
          .then((verdict) => {
            appLoads.delete(paused.requestId);
            if (verdict === "allow")
              return ownSend("Fetch.continueRequest", { requestId: paused.requestId });
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
        const { frame } = cdpEvent(method, params);
        if (frame.parentId !== undefined) return;
        mainFrameId = frame.id;
        url = `${frame.url}${frame.urlFragment ?? ""}`;
        refreshHistory();
        events.emit("did-navigate", {}, url);
        return;
      }
      case "Page.navigatedWithinDocument": {
        const event = cdpEvent(method, params);
        if (event.frameId !== mainFrameId) return;
        url = event.url;
        refreshHistory();
        return;
      }
      case "Page.frameStartedLoading": {
        if (cdpEvent(method, params).frameId === mainFrameId) loading = true;
        return;
      }
      case "Page.javascriptDialogOpening": {
        void ownSend("Page.handleJavaScriptDialog", {
          accept: cdpEvent(method, params).type === "beforeunload",
        }).catch(() => {});
        return;
      }
      case "Page.screencastFrame": {
        const frame = cdpEvent(method, params);
        onFrame?.({
          jpeg: frame.data,
          width: frame.metadata.deviceWidth,
          height: frame.metadata.deviceHeight,
        });
        const wait = Math.max(0, lastFrameAt + FRAME_INTERVAL_MS - Date.now());
        lastFrameAt = Date.now() + wait;
        setTimeout(() => {
          if (!destroyed)
            void ownSend("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
        }, wait);
        return;
      }
      case "Page.frameStoppedLoading": {
        if (cdpEvent(method, params).frameId !== mainFrameId) return;
        refreshHistory();
        void refreshTitle().then(() => {
          loading = false;
          events.emit("did-stop-loading");
        });
        return;
      }
      default:
    }
  });

  const { frameTree } = await cdpSend(connection, "Page.getFrameTree", undefined, own);
  mainFrameId = frameTree.frame.id;
  url = frameTree.frame.url;
  await ownSend("Page.enable");
  await ownSend("Fetch.enable", ALL_REQUESTS);
  await ownSend("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SETUP });
  await ownSend("Page.setPrerenderingAllowed", { isAllowed: false }).catch(() => {});
  await ownSend("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  await connection.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  refreshHistory();
  closers.set(contents, () => {
    destroy();
    void connection.send("Target.closeTarget", { targetId }).catch(() => {});
    dispose();
  });
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
  busy: (threadId: string) => boolean = () => false,
  loopbackProxyOf: (threadId: string) => string | undefined = () => undefined,
): PaneViews & {
  touch(threadId: string): void;
  close(threadId: string): Promise<void>;
  /** The thread's page if it has one, without counting as a use of it. */
  peek(threadId: string): Promise<PaneContents | undefined>;
  /** The loopback proxy the thread's page was made with; `undefined` when it has no page. */
  builtWith(threadId: string): { readonly proxy: string | undefined } | undefined;
} => {
  const pages = new Map<string, Promise<PaneContents | undefined>>();
  const proxies = new WeakMap<Promise<PaneContents | undefined>, string | undefined>();
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
    const proxy = loopbackProxyOf(threadId);
    const made = openHeadlessPage(connection, gate, proxy).catch((error: unknown) => {
      failed(error);
      return undefined;
    });
    proxies.set(made, proxy);
    pages.set(threadId, made);
    return made;
  };
  return {
    touch,
    builtWith: (threadId) => {
      const page = pages.get(threadId);
      return page === undefined ? undefined : { proxy: proxies.get(page) };
    },
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
          if (page !== undefined) closeHeadlessPage(page);
          if (pages.get(threadId) === known) pages.delete(threadId);
          return create ? openFor(threadId) : undefined;
        });
      }
      return create ? openFor(threadId) : undefined;
    },
  };
};

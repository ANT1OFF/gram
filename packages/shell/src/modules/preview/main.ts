import {
  app,
  BrowserWindow,
  session,
  WebContentsView,
  type AuthInfo,
  type Session,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";

import { loopbackUrl, webUrl, type PreviewState } from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import type { ShellLog } from "../../core/log.ts";
import {
  MAX_PREVIEWS,
  parsePreviewBounds,
  previewNavigation,
  previewRequest,
  unattributedRequest,
  previewsToClose,
  previewThreadOf,
  resolvedWithin,
  createHostDoors,
  webNavigation,
  webNetworkOf,
  destinationOf,
  webRequest,
  windowRect,
  type WebLookup,
  type WebNetwork,
} from "../../core/preview-rules.ts";
import {
  boundedLookup,
  startWebProxy,
  systemLookup,
  type WebDial,
  type WebProxy,
} from "../../core/web-proxy.ts";
import type { ShellIpc } from "../ipc.ts";
import { focusedAppWindow } from "../../electron/decision-windows.ts";
import { installAgentHandlers, type PreviewAgent } from "./agent-handlers.ts";
export type { PreviewAgent, PreviewRequestDetails } from "./agent-handlers.ts";
import { installPickHandlers } from "./pick-handlers.ts";
import { guardWebRtc, heldForGuard, webRtcGuardHeld } from "./webrtc-guard.ts";
import { installWebRtcSwitch, originOf, switchOriginOf } from "./webrtc-allowance.ts";

/**
 * No `persist:` prefix, so their cookies and storage live in memory and are gone at quit. The local
 * one is also where the agent browser resolves hosts. `web` is the shared session for the internet;
 * a thread's private network pages get `${privateWeb}-<n>`, one per thread.
 */
export const PREVIEW_PARTITIONS = {
  local: "gram-preview",
  web: "gram-preview-web",
  privateWeb: "gram-preview-lan",
  /** A thread's page the user let use WebRTC: `${webRtc}-<n>`, its storage cleared each time. */
  webRtc: "gram-preview-webrtc",
} as const;

/** Which kind of session a thread's page is in: loopback and agents' pages, or the user's web pages. */
export type PreviewKind = "local" | "web";

const HOPS_KEPT = 64;

const AGENT_PAGE_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 } as const;

const ERR_ABORTED = -3;

/**
 * What every session of untrusted pages shares, the preview's and pinned pages' (`modules/pages`):
 * no permission, device, download or spell checking.
 */
export function harden(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setSpellCheckerEnabled(false);
  ses.on("will-download", (event) => event.preventDefault());
}

/** What the preview needs from the app that installs it. */
export interface PreviewOptions {
  /** Opens a link off loopback (or a new window) through the shell's link question. */
  readonly openLink: (url: string, window: BrowserWindow) => Promise<boolean>;
  readonly log: ShellLog;
  /** Agents' pages (`modules/agent-browser`), asked before an agent's page goes anywhere. */
  readonly agent?: PreviewAgent | undefined;
  /**
   * The one lookup the web session's request check and its proxy share; the system's when absent.
   * For a fixture that answers for names of its own.
   */
  readonly lookupWebHost?: WebLookup | undefined;
  /** How the web session's proxy connects to an address it checked; directly when absent. */
  readonly dialWebAddress?: WebDial | undefined;
  /** Gram's own loopback origins (its server's, its dev web app's), whose pages never get WebRTC. */
  readonly appOrigins?: (() => Iterable<string>) | undefined;
}

interface Preview {
  readonly threadId: string;
  readonly kind: PreviewKind;
  readonly network: WebNetwork | undefined;
  readonly destination: string | undefined;
  readonly token: string | undefined;
  readonly view: WebContentsView;
  rect: { x: number; y: number; width: number; height: number } | undefined;
  window: BrowserWindow | undefined;
  readonly watchers: Set<WebContents>;
  error: string | undefined;
  readonly guarded: Promise<boolean>;
  readonly webRtcOrigin: string | undefined;
  typedOrigin: string | undefined;
}

/** What main can reach of the previews, for tools that act on a page from the main process. */
export interface PreviewHost {
  /**
   * `threadId`'s page in the local session, while it has one: loaded, shown in a window or not.
   * A web page the user opened is never handed out.
   */
  contentsOf(threadId: string): WebContents | undefined;
  /**
   * As `contentsOf`, making the page, blank and out of sight, when `create` and there is none. A
   * web page the user opened there is closed for it, unread.
   */
  contentsFor(threadId: string, create: boolean): Promise<WebContents | undefined>;
  /** Tells the windows watching `threadId`'s page that it changed, as its driver does. */
  changed(threadId: string): void;
}

/** Serves `window.gram.preview` for every window. */
export function installPreview(ipc: ShellIpc, options: PreviewOptions): PreviewHost {
  const previews = new Map<string, Preview>();
  const previewContents = new WeakSet<WebContents>();
  const sessions = new Map<string, Session>();
  const privatePartitions = new Map<string, number>();
  const webRtcPartitions = new Map<string, number>();
  const proxies = new Map<string, { readonly proxy: WebProxy; readonly ses: Session }>();
  const reopenable = new Map<string, { readonly token: string; readonly url: string }>();
  const leavingWebRtc = new Map<number, (url: string) => boolean>();

  app.on("login", (event, contents, _details, authInfo: AuthInfo, callback) => {
    const known = authInfo.isProxy ? proxies.get(authInfo.realm) : undefined;
    if (
      known === undefined ||
      authInfo.port !== known.proxy.port ||
      (contents !== null && contents.session !== known.ses)
    )
      return;
    event.preventDefault();
    callback(known.proxy.username, known.proxy.password);
  });

  app.on("select-client-certificate", (event, contents, _url, _list, callback) => {
    if (contents === null || !previewContents.has(contents)) return;
    event.preventDefault();
    callback();
  });

  const LOOPBACK_BYPASS = "<-loopback>;127.0.0.1;[::1];localhost";

  const localSession = (ses: Session) => {
    const doors = createHostDoors();
    const pinned = startWebProxy({
      lookup: options.lookupWebHost ?? systemLookup,
      dial: options.dialWebAddress,
      admits: (hostname) => doors.admits(hostname),
      onError: (error) =>
        options.log.warn({ source: "preview", error: String(error) }, "the local proxy failed"),
    })
      .then(async (proxy) => {
        proxies.set(proxy.realm, { proxy, ses });
        app.once("will-quit", () => void proxy.close());
        return `127.0.0.1:${proxy.port}`;
      })
      .catch((error: unknown) => {
        options.log.error(
          { source: "preview", error: String(error) },
          "the local session's proxy didn't start; its pages reach loopback alone",
        );
        return "127.0.0.1:9";
      })
      .then(async (proxyRules) => {
        await ses.setProxy({
          mode: "fixed_servers",
          proxyRules,
          proxyBypassRules: LOOPBACK_BYPASS,
        });
        return true;
      })
      .catch(() => false);
    const answer = (
      url: string,
      callback: (response: { cancel?: boolean }) => void,
      allowed: boolean,
    ) => {
      void pinned.then(
        (ready) => {
          if (ready && allowed) doors.open(url);
          callback(ready && allowed ? {} : { cancel: true });
        },
        () => callback({ cancel: true }),
      );
    };
    ses.webRequest.onBeforeRequest(
      heldForGuard((details: Electron.OnBeforeRequestListenerDetails, callback) => {
        const leave =
          details.resourceType === "mainFrame" && details.webContents !== undefined
            ? leavingWebRtc.get(details.webContents.id)
            : undefined;
        if (leave?.(details.url) === true) {
          callback({ cancel: true });
          return;
        }
        const asked =
          details.webContents === undefined
            ? undefined
            : options.agent?.request(details.webContents, {
                id: details.id,
                url: details.url,
                method: details.method,
                mainFrame: details.resourceType === "mainFrame",
                subFrame: details.resourceType === "subFrame",
                ...(details.initiatorOrigin === undefined
                  ? {}
                  : { initiator: details.initiatorOrigin }),
              });
        if (asked !== undefined) {
          void asked.then(
            (verdict) => answer(details.url, callback, verdict === "allow"),
            () => callback({ cancel: true }),
          );
          return;
        }
        const verdict =
          details.webContents === undefined
            ? unattributedRequest(details.url, details.initiatorOrigin)
            : previewRequest(details.url);
        answer(details.url, callback, verdict === "allow");
      }),
    );
  };

  const webSession = (ses: Session, network: WebNetwork, destination: string | undefined) => {
    const lookup = options.lookupWebHost ?? systemLookup;
    const proxied = startWebProxy({
      lookup,
      dial: options.dialWebAddress,
      privateDestination: network === "private" ? destination : undefined,
      onError: (error) =>
        options.log.warn({ source: "preview", error: String(error) }, "the web proxy failed"),
    })
      .then(async (proxy) => {
        proxies.set(proxy.realm, { proxy, ses });
        await ses.setProxy({
          mode: "fixed_servers",
          proxyRules: `127.0.0.1:${proxy.port}`,
          proxyBypassRules: "<-loopback>",
        });
        app.once("will-quit", () => void proxy.close());
        return true;
      })
      .catch((error: unknown) => {
        options.log.error(
          { source: "preview", error: String(error) },
          "a web session's proxy didn't start; its pages load nothing",
        );
        return false;
      });
    const bounded: WebLookup = async (host) => (await boundedLookup(lookup, host)) ?? [];
    const hops = new Map<number, string>();
    ses.webRequest.onBeforeRequest((details, callback) => {
      const mainFrame = details.resourceType === "mainFrame";
      const before = mainFrame ? hops.get(details.id) : undefined;
      if (mainFrame) {
        hops.delete(details.id);
        hops.set(details.id, details.url);
        if (hops.size > HOPS_KEPT) hops.delete(hops.keys().next().value!);
      }
      const page = details.webContents?.isDestroyed() === false ? details.webContents.getURL() : "";
      const verdict = webRequest({
        url: details.url,
        mainFrame,
        subFrame: details.resourceType === "subFrame",
        network,
        destination,
        initiator: details.initiatorOrigin,
        before,
        ...(page === "" ? {} : { page }),
      });
      const allowed: Promise<boolean> =
        verdict.kind === "resolve"
          ? resolvedWithin(bounded, verdict.host, verdict.bound)
          : Promise.resolve(verdict.kind === "allow");
      void Promise.all([proxied, allowed]).then(
        ([ready, ok]) => callback(ready && ok ? {} : { cancel: true }),
        () => callback({ cancel: true }),
      );
    });
  };

  const sessionOf = (
    kind: PreviewKind,
    threadId: string,
    network: WebNetwork | undefined,
    destination: string | undefined,
    webRtc = false,
  ) => {
    let partition: string = PREVIEW_PARTITIONS.local;
    if (kind === "local" && webRtc) {
      const n = webRtcPartitions.get(threadId) ?? webRtcPartitions.size + 1;
      webRtcPartitions.set(threadId, n);
      partition = `${PREVIEW_PARTITIONS.webRtc}-${n}`;
    } else if (kind === "web" && network === "private") {
      const key = `${threadId} ${destination ?? ""}`;
      let n = privatePartitions.get(key);
      if (n === undefined) {
        n = privatePartitions.size + 1;
        privatePartitions.set(key, n);
      }
      partition = `${PREVIEW_PARTITIONS.privateWeb}-${n}`;
    } else if (kind === "web") {
      partition = PREVIEW_PARTITIONS.web;
    }
    const known = sessions.get(partition);
    if (known !== undefined) return known;
    const ses = session.fromPartition(partition);
    harden(ses);
    if (kind === "local") localSession(ses);
    else webSession(ses, network ?? "public", destination);
    sessions.set(partition, ses);
    return ses;
  };

  const switchOrigin = switchOriginOf(options.agent, options.appOrigins);

  const stateOf = (preview: Preview): PreviewState | null => {
    const contents = preview.view.webContents;
    if (contents.isDestroyed()) return null;
    const url = contents.getURL();
    if (url === "") return null;
    const agent = preview.kind === "local" ? options.agent : undefined;
    const driver = agent?.driverOf(preview.threadId);
    const browserInspection = agent?.inspectionOf(preview.threadId);
    const action = agent?.actionOf?.(preview.threadId);
    const recording = agent?.recordingOf?.(preview.threadId) === true;
    return {
      url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(preview.error === undefined ? {} : { error: preview.error }),
      ...(driver === undefined ? {} : { driver }),
      ...(browserInspection === undefined ? {} : { browserInspection }),
      ...(action === undefined ? {} : { action }),
      ...(recording ? { recording } : {}),
      ...(preview.token === undefined ? {} : { webView: preview.token }),
      ...(preview.webRtcOrigin === undefined ? {} : { webRtc: true }),
      ...(switchOrigin(preview) === undefined ? {} : { webRtcOffered: true }),
    };
  };

  const report = (preview: Preview) => {
    const state = stateOf(preview);
    if (state === null) return;
    for (const watcher of preview.watchers) {
      if (watcher.isDestroyed()) preview.watchers.delete(watcher);
      else watcher.send(Channels.previewState, { threadId: preview.threadId, state });
    }
  };

  const touch = (preview: Preview) => {
    previews.delete(preview.threadId);
    previews.set(preview.threadId, preview);
  };

  const detach = (preview: Preview) => {
    const { window, view } = preview;
    if (window === undefined) return;
    preview.window = undefined;
    const hadFocus = !view.webContents.isDestroyed() && view.webContents.isFocused();
    view.setVisible(false);
    if (window.isDestroyed()) return;
    window.contentView.removeChildView(view);
    if (hadFocus) window.webContents.focus();
  };

  const close = (preview: Preview) => {
    if (previews.get(preview.threadId) !== preview) return;
    previews.delete(preview.threadId);
    detach(preview);
    if (!preview.view.webContents.isDestroyed()) preview.view.webContents.close();
  };

  const watched = new WeakSet<BrowserWindow>();
  const leave = (window: BrowserWindow) => {
    for (const preview of previews.values()) if (preview.window === window) detach(preview);
  };

  const attach = (preview: Preview, window: BrowserWindow) => {
    if (preview.window === window) return;
    detach(preview);
    preview.window = window;
    window.contentView.addChildView(preview.view);
    if (watched.has(window)) return;
    watched.add(window);
    window.webContents.on("did-navigate", () => leave(window));
    window.once("closed", () => leave(window));
  };

  const create = (
    threadId: string,
    kind: PreviewKind,
    opening?: string,
    webRtcOrigin?: string,
  ): Preview => {
    const web = kind === "web" ? webNetworkOf(opening ?? "") : undefined;
    const destination = web === "private" ? destinationOf(opening ?? "") : undefined;
    const view = new WebContentsView({
      webPreferences: {
        session: sessionOf(kind, threadId, web, destination, webRtcOrigin !== undefined),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        ...(kind === "local" ? { disableBlinkFeatures: "SharedWorker" } : {}),
      },
    });
    view.setVisible(false);
    view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    const preview: Preview = {
      threadId,
      kind,
      network: web,
      destination,
      token: web === undefined ? undefined : randomUUID(),
      view,
      rect: undefined,
      window: undefined,
      watchers: new Set(),
      error: undefined,
      guarded:
        kind === "local" && webRtcOrigin === undefined
          ? guardWebRtc(view.webContents, (fields, message) => options.log.warn(fields, message))
          : Promise.resolve(true),
      webRtcOrigin: kind === "local" ? webRtcOrigin : undefined,
      typedOrigin: undefined,
    };
    const contents = view.webContents;
    previewContents.add(contents);
    contents.once("destroyed", () => {
      if (previews.get(threadId) === preview) previews.delete(threadId);
    });

    const send = () => report(preview);
    const toLinkGate = (url: string) => {
      const window = preview.window ?? focusedAppWindow();
      if (window !== null && !window.isDestroyed()) void options.openLink(url, window);
    };
    contents.setWindowOpenHandler(({ url }) => {
      toLinkGate(url);
      return { action: "deny" };
    });
    const steerLocal = (event: { preventDefault(): void }, url: string) => {
      const agentSays = options.agent?.navigation(contents, url);
      if (agentSays === "load") return;
      if (agentSays === "block") {
        event.preventDefault();
        return;
      }
      const decision = previewNavigation(url);
      if (decision === "load") return;
      event.preventDefault();
      if (decision === "web") toLinkGate(url);
    };
    const steerWeb = (event: { preventDefault(): void }, url: string, redirect: boolean) => {
      const decision = webNavigation(url);
      if (decision === "load" && web === "private" && webNetworkOf(url) === "public") {
        event.preventDefault();
        setImmediate(() => {
          if (previews.get(threadId) === preview) void openIn(preview, "web", url);
        });
        return;
      }
      if (decision === "load" && web === "private" && destinationOf(url) !== destination) {
        event.preventDefault();
        if (!redirect) toLinkGate(url);
        return;
      }
      if (decision === "load") return;
      event.preventDefault();
      if (decision === "local" && !redirect) toLinkGate(url);
    };
    const leavesWebRtc = (url: string) =>
      preview.webRtcOrigin !== undefined && originOf(url) !== preview.webRtcOrigin;
    const guardAgain = (url: string) =>
      setImmediate(() => {
        if (previews.get(threadId) !== preview) return;
        const next = replace(preview, "local");
        if (previewNavigation(url) === "load") void openIn(next, "local", url);
        else report(next);
      });
    const steer = (event: { preventDefault(): void }, url: string, redirect: boolean) => {
      if (leavesWebRtc(url) && previewNavigation(url) === "load") {
        event.preventDefault();
        guardAgain(url);
      } else if (kind === "local") steerLocal(event, url);
      else steerWeb(event, url, redirect);
    };
    contents.on("will-navigate", (event) => {
      if (event.isMainFrame) steer(event, event.url, false);
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) steer(event, event.url, true);
    });
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      preview.error = undefined;
      if (leavesWebRtc(event.url)) guardAgain(event.url);
    });
    if (preview.webRtcOrigin !== undefined) {
      const id = contents.id;
      leavingWebRtc.set(id, (url) => {
        if (!leavesWebRtc(url)) return false;
        guardAgain(url);
        return true;
      });
      contents.once("destroyed", () => leavingWebRtc.delete(id));
    }
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      preview.error = description === "" ? `Error ${code}` : description;
      options.log.info({ source: "preview", code }, "the preview's page didn't load");
      send();
    });
    contents.on("render-process-gone", (_event, details) => {
      preview.error = `the page stopped (${details.reason})`;
      send();
    });
    if (kind === "local") {
      contents.on("before-input-event", (_event, input) => {
        if (input.type === "keyDown") options.agent?.userInput(contents);
      });
      contents.on("before-mouse-event", (_event, mouse) => {
        if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
          options.agent?.userInput(contents);
      });
    }
    contents.on("did-start-loading", send);
    contents.on("did-stop-loading", send);
    contents.on("did-navigate", send);
    contents.on("did-navigate-in-page", send);
    contents.on("page-title-updated", send);

    const shown = (id: string) => previews.get(id)?.window !== undefined;
    for (const id of previewsToClose([...previews.keys()], shown, MAX_PREVIEWS - 1)) {
      const old = previews.get(id);
      if (old === undefined) continue;
      const at = old.view.webContents.isDestroyed() ? "" : old.view.webContents.getURL();
      if (old.token !== undefined && webUrl(at) !== undefined)
        reopenable.set(id, { token: old.token, url: at });
      close(old);
    }
    previews.set(threadId, preview);
    return preview;
  };

  const replace = (
    old: Preview,
    kind: PreviewKind,
    url?: string,
    webRtcOrigin?: string,
  ): Preview => {
    const { window, rect, watchers } = old;
    close(old);
    const next = create(old.threadId, kind, url, webRtcOrigin);
    for (const watcher of watchers) next.watchers.add(watcher);
    touch(next);
    if (window !== undefined && !window.isDestroyed() && rect !== undefined) {
      attach(next, window);
      next.rect = rect;
      next.view.setBounds(rect);
      next.view.setVisible(true);
    }
    return next;
  };

  const openIn = async (preview: Preview, kind: PreviewKind, url: string) => {
    const network = kind === "web" ? webNetworkOf(url) : undefined;
    const destination = network === "private" ? destinationOf(url) : undefined;
    const target =
      preview.kind === kind && preview.network === network && preview.destination === destination
        ? preview
        : replace(preview, kind, url);
    target.error = undefined;
    if (await target.guarded) await target.view.webContents.loadURL(url).catch(() => {});
    report(target);
  };

  const previewFor = (input: unknown, sender: WebContents): Preview | undefined => {
    const threadId = previewThreadOf(input);
    const preview = threadId === undefined ? undefined : previews.get(threadId);
    preview?.watchers.add(sender);
    return preview;
  };

  const openFor = async (
    input: unknown,
    sender: WebContents,
    kind: PreviewKind,
    rule: (raw: string) => string | undefined,
  ) => {
    const threadId = previewThreadOf(input);
    const raw: unknown = threadId === undefined ? undefined : Reflect.get(input as object, "url");
    const url = typeof raw === "string" ? rule(raw) : undefined;
    if (threadId === undefined || url === undefined) return false;
    reopenable.delete(threadId);
    const known = previews.get(threadId);
    const preview =
      known === undefined
        ? create(threadId, kind, url)
        : known.webRtcOrigin === undefined
          ? known
          : replace(known, kind, url);
    touch(preview);
    preview.watchers.add(sender);
    preview.typedOrigin =
      kind === "local" && Reflect.get(input as object, "typed") === true
        ? originOf(url)
        : undefined;
    await openIn(preview, kind, url);
    return true;
  };
  ipc.handle(Channels.previewOpen, (input, event) =>
    openFor(input, event.sender, "local", loopbackUrl),
  );
  ipc.handle(Channels.previewOpenWeb, (input, event) =>
    openFor(input, event.sender, "web", (raw) =>
      loopbackUrl(raw) === undefined ? webUrl(raw) : undefined,
    ),
  );
  ipc.handle(Channels.previewReopenWeb, async (input, event) => {
    const threadId = previewThreadOf(input);
    const token: unknown =
      threadId === undefined ? undefined : Reflect.get(input as object, "token");
    const closed = threadId === undefined ? undefined : reopenable.get(threadId);
    if (
      threadId === undefined ||
      closed === undefined ||
      typeof token !== "string" ||
      token !== closed.token ||
      previews.has(threadId)
    )
      return false;
    reopenable.delete(threadId);
    const preview = create(threadId, "web", closed.url);
    touch(preview);
    preview.watchers.add(event.sender);
    await openIn(preview, "web", closed.url);
    return true;
  });
  ipc.on(Channels.previewBounds, (event, input) => {
    const preview = previewFor(input, event.sender);
    const window = BrowserWindow.fromWebContents(event.sender);
    const bounds = parsePreviewBounds(
      typeof input === "object" && input !== null ? Reflect.get(input, "bounds") : undefined,
    );
    if (preview === undefined || window === null || bounds === undefined) return;
    if (bounds === null || bounds.width === 0 || bounds.height === 0) {
      if (preview.window === window) detach(preview);
      return;
    }
    touch(preview);
    attach(preview, window);
    preview.rect = windowRect(bounds, event.sender.getZoomFactor());
    preview.view.setBounds(preview.rect);
    preview.view.setVisible(true);
  });
  ipc.on(Channels.previewBack, (event, input) => {
    const history = previewFor(input, event.sender)?.view.webContents.navigationHistory;
    if (history?.canGoBack() === true) history.goBack();
  });
  ipc.on(Channels.previewForward, (event, input) => {
    const history = previewFor(input, event.sender)?.view.webContents.navigationHistory;
    if (history?.canGoForward() === true) history.goForward();
  });
  ipc.on(Channels.previewReload, (event, input) => {
    const preview = previewFor(input, event.sender);
    if (preview === undefined) return;
    preview.error = undefined;
    preview.view.webContents.reload();
  });
  installWebRtcSwitch(ipc, {
    previewFor,
    originFor: switchOrigin,
    remake: async (preview, origin) => {
      const next = replace(preview, "local", undefined, origin);
      const ses = next.view.webContents.session;
      if (origin !== undefined)
        await Promise.all([ses.clearStorageData(), ses.clearCache()]).catch(() => {});
      return next;
    },
    open: (preview, url) => openIn(preview, "local", url),
    report,
  });
  installAgentHandlers(ipc, previewFor, options.agent);
  installPickHandlers(ipc, previewFor);
  ipc.handle(Channels.previewStateGet, (input, event) => {
    const preview = previewFor(input, event.sender);
    return preview === undefined ? null : stateOf(preview);
  });

  const whenGuarded = async (preview: Preview) => {
    const contents = preview.view.webContents;
    if (!(await preview.guarded) || contents.isDestroyed()) return undefined;
    const held = webRtcGuardHeld(contents);
    if (held !== undefined && !(await held)) return undefined;
    return contents.isDestroyed() ? undefined : contents;
  };
  const contentsOf = (threadId: string) => {
    const preview = previews.get(threadId);
    const contents = preview?.kind === "local" ? preview.view.webContents : undefined;
    return contents === undefined || contents.isDestroyed() ? undefined : contents;
  };
  return {
    contentsOf,
    contentsFor: async (threadId, make) => {
      const known = previews.get(threadId);
      const allowed = known?.webRtcOrigin !== undefined;
      if (!allowed && contentsOf(threadId) !== undefined && known !== undefined) {
        known.typedOrigin = undefined;
        return whenGuarded(known);
      }
      if (!make) return undefined;
      reopenable.delete(threadId);
      const old = previews.get(threadId);
      const preview = old === undefined ? create(threadId, "local") : replace(old, "local");
      touch(preview);
      if (preview.window === undefined) preview.view.setBounds(AGENT_PAGE_BOUNDS);
      return whenGuarded(preview);
    },
    changed: (threadId) => {
      const preview = previews.get(threadId);
      if (preview !== undefined) report(preview);
    },
  };
}

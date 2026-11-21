// The preview module's main half: each thread's Preview tab page, one `WebContentsView` per thread,
// drawn over the tab's placeholder in whichever window shows it and kept loaded, in no window, while
// none does, for the `MAX_PREVIEWS` most recently used threads. It is the only web content the
// shell shows that isn't the app's own, so it gets nothing of the app's: sessions of its own kept in
// memory, no preload, no permission, no download, no client certificate (`core/preview-rules.ts`).
// A thread's page is in a session of one of three kinds. The local session holds loopback pages and
// agents' pages, and loads nothing off loopback but what the agent browser allows an agent's page;
// it reaches loopback directly and anything else only through a proxy of its own, which connects
// only to a host that check just let a page reach, so a socket the check never sees goes no further.
// Its pages have no shared worker, whose sockets that check never sees either, and no WebRTC,
// which looks names up past it (`webrtc-guard.ts`).
// The web sessions hold the pages the user opens anywhere else, and no agent ever drives or reads
// them, so what the user signs in to there stays theirs. The shared web session holds pages on the
// internet, and never reaches loopback or a private network, whatever asks. A page the user opens
// on a private network gets its thread's own private web session, which runs nothing but private
// pages: a link from one to the internet opens in the shared session, and a public frame doesn't
// load. Each web session's connections go through a proxy of its own (`core/web-proxy.ts`), which
// answers only its own credential and connects only to the addresses it checked; its WebRTC never
// uses UDP. Only the user's own address strip opens a web page, or re-opens one the shell closed
// for newer threads' (`PreviewState.webView`); a local page leaving loopback goes to the link
// question, and an agent taking the pane starts a page in the local session. A new window goes to
// the link question.

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

/**
 * No `persist:` prefix, so their cookies and storage live in memory and are gone at quit. The local
 * one is also where the agent browser resolves hosts. `web` is the shared session for the internet;
 * a thread's private network pages get `${privateWeb}-<n>`, one per thread.
 */
export const PREVIEW_PARTITIONS = {
  local: "gram-preview",
  web: "gram-preview-web",
  privateWeb: "gram-preview-lan",
} as const;

/** Which kind of session a thread's page is in: loopback and agents' pages, or the user's web pages. */
export type PreviewKind = "local" | "web";

/** How many main-frame requests' latest hops are kept, for the redirect that follows each. */
const HOPS_KEPT = 64;

/** The size an agent's page lays out at until a window shows it, a laptop's usual pane. */
const AGENT_PAGE_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 } as const;

/** Chromium's code for a load that was superseded or stopped, which isn't a failure to show. */
const ERR_ABORTED = -3;

/**
 * What every session of untrusted pages shares, the preview's and pinned pages' (`modules/pages`):
 * no permission, device, download or spell checking.
 */
export function harden(ses: Session): void {
  // Camera, microphone, location, notifications, the clipboard, and `openExternal`, which is how
  // Electron asks before a page launches another app by its scheme (`zoommtg:`, `vscode:`).
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
}

interface Preview {
  readonly threadId: string;
  readonly kind: PreviewKind;
  /** For a web page, which web session: the shared one, or the thread's private network one. */
  readonly network: WebNetwork | undefined;
  /** For a private network page, the one private destination its session reaches. */
  readonly destination: string | undefined;
  /**
   * For a web page, this view's own token, for its life only (`PreviewState.webView`): what the
   * renderer names to re-open it after the shell closed it for newer threads'.
   */
  readonly token: string | undefined;
  readonly view: WebContentsView;
  /** Where in `window` it was last drawn, so a page made again in the other session takes its place. */
  rect: { x: number; y: number; width: number; height: number } | undefined;
  /** The window whose Preview tab shows the page; `undefined` while none does. */
  window: BrowserWindow | undefined;
  /** The app pages that asked about this thread's page, told each time it changes. */
  readonly watchers: Set<WebContents>;
  error: string | undefined;
  /**
   * Whether the page may load: in the local session, once WebRTC is gone from it (`webrtc-guard.ts`),
   * and never if it couldn't be taken away; a web page at once.
   */
  readonly guarded: Promise<boolean>;
  /**
   * The origin the user let this local page use WebRTC on (`setWebRtc`), its guard off; anything
   * else opening in the thread, an agent taking it, or its main frame leaving that origin makes
   * the page again with the guard on.
   */
  readonly webRtcOrigin: string | undefined;
}

/** `url`'s origin, `undefined` for one that has none. */
const originOf = (url: string) => {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

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
  /** Each thread's preview, least recently used first. */
  const previews = new Map<string, Preview>();
  const previewContents = new WeakSet<WebContents>();
  /** The sessions made so far, by partition. */
  const sessions = new Map<string, Session>();
  /**
   * Each private network session's partition number, by its thread and the one destination the
   * user opened there (`destinationOf`): another private place, even in the same thread, is
   * another session, with a proxy of its own.
   */
  const privatePartitions = new Map<string, number>();
  /** Each web session's proxy, by the realm it asks for its credential in. */
  const proxies = new Map<string, { readonly proxy: WebProxy; readonly ses: Session }>();
  /**
   * The thread's user web page the shell closed for newer threads', which the renderer may have
   * re-opened by its token: its URL is the shell's own record, never the renderer's. Gone as soon
   * as anything else opens in the thread, an agent's page above all.
   */
  const reopenable = new Map<string, { readonly token: string; readonly url: string }>();
  /**
   * For each local page the user let use WebRTC, by its contents' id: whether a document at a URL
   * leaves the origin they let it for, in which case the page is made again guarded, to load it.
   */
  const leavingWebRtc = new Map<number, (url: string) => boolean>();

  // Each web session's proxy credential, for Chromium only: asked for by that proxy's own realm and
  // port, for that session's pages.
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

  // Electron picks the first certificate in the store when nobody answers, which on a managed
  // laptop can be the device's own, the one that signs in to internal sites.
  app.on("select-client-certificate", (event, contents, _url, _list, callback) => {
    if (contents === null || !previewContents.has(contents)) return;
    event.preventDefault();
    callback();
  });

  /**
   * Chromium connects to these directly and sends everything else to the session's proxy. Its own
   * implicit bypass also covers link-local addresses (where a cloud's metadata service lives), so
   * that is taken away (`<-loopback>`) and loopback alone is named, as the headless browser does.
   */
  const LOOPBACK_BYPASS = "<-loopback>;127.0.0.1;[::1];localhost";

  const localSession = (ses: Session) => {
    // Loopback directly; anything else only through the session's own proxy, which connects only
    // to a public host this session's request check let a page reach just now (`createHostDoors`)
    // and checks the very address it dials, so WebRTC, a worker's socket or a preconnect, which
    // that check never sees, reaches no other host and no private network. Until the proxy is in
    // place nothing goes out; if it can't start, the session is held to loopback alone, through a
    // proxy that is a closed port.
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
    // A page whose WebRTC removal isn't in place waits for it, and loads nothing without it.
    ses.webRequest.onBeforeRequest(
      heldForGuard((details: Electron.OnBeforeRequestListenerDetails, callback) => {
        // A page the user let use WebRTC loads no other origin's document: it is made again
        // guarded, and that loads there.
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
    // Every connection goes through the session's own proxy, which resolves each name once and
    // connects to the very address it checked, and reaches a private network only in a private
    // network page's own session, and there only the one destination the user opened, so a frame,
    // WebRTC or a preconnect in it reaches no other; the system's proxy, which could send a name
    // anywhere, is never used. Until it is in place nothing goes out, and if it can't be, nothing
    // ever does.
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
          // Loopback too, which Chromium would otherwise connect to directly.
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
    /** Each main-frame request's latest URL, by id, so its next redirect knows where it came from. */
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
      // The page's zone as well as the address's: checked here, where the request's origin is
      // known, and again by the proxy for the connection itself.
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

  /** The session a thread's page of `kind` is made in, made the first time it is asked for. */
  const sessionOf = (
    kind: PreviewKind,
    threadId: string,
    network: WebNetwork | undefined,
    destination: string | undefined,
  ) => {
    let partition: string = PREVIEW_PARTITIONS.local;
    if (kind === "web" && network === "private") {
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

  const stateOf = (preview: Preview): PreviewState | null => {
    const contents = preview.view.webContents;
    if (contents.isDestroyed()) return null;
    const url = contents.getURL();
    if (url === "") return null;
    // No agent drives or reads a web page the user opened.
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

  /** Moves `preview` to the end of the order, the most recently used. */
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
    // Keys typed after a hide would otherwise go to a page nobody can see.
    if (hadFocus) window.webContents.focus();
  };

  const close = (preview: Preview) => {
    if (previews.get(preview.threadId) !== preview) return;
    previews.delete(preview.threadId);
    detach(preview);
    if (!preview.view.webContents.isDestroyed()) preview.view.webContents.close();
  };

  /** The windows whose reload and close take their previews out. */
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
    // An app page that reloads hasn't placed its previews yet, so they would float over it.
    window.webContents.on("did-navigate", () => leave(window));
    window.once("closed", () => leave(window));
  };

  /** `threadId`'s page of `kind`, for a web page in the session `opening` belongs in. */
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
        session: sessionOf(kind, threadId, web, destination),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        // A shared worker's requests reach the session with no page to check them against, and
        // its sockets don't reach the request check at all, so in the local session, which
        // reaches loopback directly, an agent's page on a public host could talk to this
        // computer's servers through one. The local session's pages have none; a service worker
        // can't start there from a public page, since fetching its script is such a request.
        ...(kind === "local" ? { disableBlinkFeatures: "SharedWorker" } : {}),
      },
    });
    view.setVisible(false);
    // WebRTC's sockets don't pass the session's request check: no UDP at all, and TCP only through
    // the session's proxy, which reaches a private network only for a private page's own session,
    // a public host from the local session only where its request check just let a page go, and
    // loopback never. Set on the page itself, so every frame in it holds to it.
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
      // A local page leaving loopback, by a link, a script or a redirect, never crosses into the
      // web session, where the user's sign-ins are: the page may be an agent's (`show_panel`
      // opens one with no driver attached), and nothing it does is the user's consent. The link
      // goes to the link question; only the user's own address strip opens a web page here.
      if (decision === "web") toLinkGate(url);
    };
    const steerWeb = (event: { preventDefault(): void }, url: string, redirect: boolean) => {
      const decision = webNavigation(url);
      // A private network page's session runs nothing but private pages: a link, script or
      // redirect from one to the internet opens in the shared session, as any page's link does
      // there, after this event, since that closes the page raising it. The shared session never
      // loads a private network's page, whoever asks: its request check refuses it.
      if (decision === "load" && web === "private" && webNetworkOf(url) === "public") {
        event.preventDefault();
        setImmediate(() => {
          if (previews.get(threadId) === preview) void openIn(preview, "web", url);
        });
        return;
      }
      // Nor another private place than the one the user opened: that takes their own act, typing
      // it, so a link goes to the link question and a redirect there just stops.
      if (decision === "load" && web === "private" && destinationOf(url) !== destination) {
        event.preventDefault();
        if (!redirect) toLinkGate(url);
        return;
      }
      if (decision === "load") return;
      event.preventDefault();
      // A site sending the pane to this computer's own addresses: the user decides, in their
      // browser. A redirect there, which nobody clicked, just stops.
      if (decision === "local" && !redirect) toLinkGate(url);
    };
    // The user let WebRTC on for one origin: the page leaving it is made again with the guard on,
    // and goes on there only where a local page may.
    const leavesWebRtc = (url: string) =>
      preview.webRtcOrigin !== undefined && originOf(url) !== preview.webRtcOrigin;
    const guardAgain = (url: string) =>
      // After the event raising it: closing the page inside its own navigation's events crashes.
      setImmediate(() => {
        if (previews.get(threadId) !== preview) return;
        const next = replace(preview, "local");
        if (previewNavigation(url) === "load") void openIn(next, "local", url);
        else report(next);
      });
    const steer = (event: { preventDefault(): void }, url: string, redirect: boolean) => {
      if (leavesWebRtc(url)) {
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
      // Back or forward to another origin, which no `will-navigate` asks about; its request the
      // session's check refuses, and a page kept in the back-forward cache is closed with this one.
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
    // Clicking or typing in an agent's page takes it over; moving the mouse over it doesn't.
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

    // Room for this one first, so the cap holds even while every other preview is shown.
    const shown = (id: string) => previews.get(id)?.window !== undefined;
    for (const id of previewsToClose([...previews.keys()], shown, MAX_PREVIEWS - 1)) {
      const old = previews.get(id);
      if (old === undefined) continue;
      // The user's own web page, closed only to make room: the renderer may ask for it again by
      // its token, and gets the page it was on, by the shell's record.
      const at = old.view.webContents.isDestroyed() ? "" : old.view.webContents.getURL();
      if (old.token !== undefined && webUrl(at) !== undefined)
        reopenable.set(id, { token: old.token, url: at });
      close(old);
    }
    previews.set(threadId, preview);
    return preview;
  };

  /**
   * `old`'s thread's page made again in `kind`'s session, in its place: in the same window at the
   * same size, told to the same windows. Nothing of the old page comes along, its history neither.
   */
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

  /** Loads `url` in the thread's page, made again first in the session it belongs in. */
  const openIn = async (preview: Preview, kind: PreviewKind, url: string) => {
    const network = kind === "web" ? webNetworkOf(url) : undefined;
    const destination = network === "private" ? destinationOf(url) : undefined;
    const target =
      preview.kind === kind && preview.network === network && preview.destination === destination
        ? preview
        : replace(preview, kind, url);
    target.error = undefined;
    // A page that won't load rejects here and reports itself through `did-fail-load`.
    if (await target.guarded) await target.view.webContents.loadURL(url).catch(() => {});
    report(target);
  };

  /** The preview `input` names, telling `sender` about it from now on. */
  const previewFor = (input: unknown, sender: WebContents): Preview | undefined => {
    const threadId = previewThreadOf(input);
    const preview = threadId === undefined ? undefined : previews.get(threadId);
    preview?.watchers.add(sender);
    return preview;
  };

  /** Loads `url`, as `rule` reads it, in `threadId`'s page in `kind`'s session. */
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
    // Anything else opening in the thread ends the closed web page's re-open.
    reopenable.delete(threadId);
    // Nothing the user didn't switch on keeps WebRTC: a port chip, an agent's `show_panel`, the
    // address strip all open in a page with the guard on.
    const known = previews.get(threadId);
    const preview =
      known === undefined
        ? create(threadId, kind, url)
        : known.webRtcOrigin === undefined
          ? known
          : replace(known, kind, url);
    touch(preview);
    preview.watchers.add(sender);
    await openIn(preview, kind, url);
    return true;
  };
  // Loopback only: what the app opens for anyone, a port chip, an agent's `show_panel`, a page
  // re-opened after it was closed for newer threads'.
  ipc.handle(Channels.previewOpen, (input, event) =>
    openFor(input, event.sender, "local", loopbackUrl),
  );
  // A web page, in a session with the user's sign-ins: only the address strip asks for one.
  // Loopback never opens there.
  ipc.handle(Channels.previewOpenWeb, (input, event) =>
    openFor(input, event.sender, "web", (raw) =>
      loopbackUrl(raw) === undefined ? webUrl(raw) : undefined,
    ),
  );
  // The user's web page the shell closed for newer threads', by the token it had: once, only
  // while nothing else has opened in the thread since, and at the URL the shell recorded.
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
      // Only the window showing it can take it away: another may have taken it over since.
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
  // The user's own switch: the page is made again, with WebRTC or without, at the same address.
  ipc.handle(Channels.previewSetWebRtc, async (input, event) => {
    const preview = previewFor(input, event.sender);
    const allowed: unknown =
      typeof input === "object" && input !== null ? Reflect.get(input, "allowed") : undefined;
    if (preview?.kind !== "local" || typeof allowed !== "boolean") return false;
    if (options.agent?.driverOf(preview.threadId) === "agent") return false;
    if ((preview.webRtcOrigin !== undefined) === allowed) return true;
    // For the origin the page is on as the user switches it, and no other.
    const url = preview.view.webContents.getURL();
    const origin = loopbackUrl(url) === undefined ? undefined : originOf(url);
    if (allowed && origin === undefined) return false;
    const next = replace(preview, "local", undefined, allowed ? origin : undefined);
    if (loopbackUrl(url) !== undefined) await openIn(next, "local", url);
    report(next);
    return true;
  });
  installAgentHandlers(ipc, previewFor, options.agent);
  installPickHandlers(ipc, previewFor);
  ipc.handle(Channels.previewStateGet, (input, event) => {
    const preview = previewFor(input, event.sender);
    return preview === undefined ? null : stateOf(preview);
  });

  /**
   * `preview`'s page, once its WebRTC is gone; none if it couldn't be taken away, or was put back
   * and then given up, which leaves a blank page.
   */
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
      // An agent's page never has WebRTC: one the user let have it is made again without, and only
      // for an agent that takes the pane; a peek leaves the user's page as it is and gets none.
      const allowed = known?.webRtcOrigin !== undefined;
      if (!allowed && contentsOf(threadId) !== undefined && known !== undefined)
        return whenGuarded(known);
      if (!make) return undefined;
      // A web page the user opened is never the agent's: it closes, unread, for a page of its own,
      // and can't be re-opened in its session after.
      reopenable.delete(threadId);
      const old = previews.get(threadId);
      const preview = old === undefined ? create(threadId, "local") : replace(old, "local");
      touch(preview);
      // A page no window has shown yet has no size, and lays out, hit-tests and captures nothing.
      if (preview.window === undefined) preview.view.setBounds(AGENT_PAGE_BOUNDS);
      return whenGuarded(preview);
    },
    changed: (threadId) => {
      const preview = previews.get(threadId);
      if (preview !== undefined) report(preview);
    },
  };
}

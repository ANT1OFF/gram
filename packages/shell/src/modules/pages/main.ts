// The pages module's main half: each pinned page in a `WebContentsView` of its own, drawn over the
// Pages tab's placeholder in whichever window shows it. Pinned pages are a trust class of their own
// (`@gram/contracts` `page-url.ts`): untrusted code the user chose to keep. They run in one session,
// `gram-pages`, kept in memory and hardened as the preview's are (`harden`): no permission (the
// clipboard's included), no device, no download. Its one preload is the clipboard guard
// (`guard.ts`), which exposes nothing: Chromium lets a page with the user's activation copy
// whatever the session's permissions say. It loads one thing, the files of
// the very page a view opened, from the page listener's origin as the server announced it, and
// nothing else: not another page's files, not another origin, not the network, not a socket, not
// WebRTC. Navigation away is stopped and popups are denied, with no link question, since nothing
// a page does is the user's consent to go anywhere.
//
// No agent reaches this session. Nothing here is handed to the agent browser (`PreviewHost` hands
// out only the local preview session's pages), and its pages are refused there, in `show_panel` and
// by the browser tools (`isPinnedPageUrl`).

import { BrowserWindow, session, WebContentsView, type Session, type WebContents } from "electron";

import { pagePolicyHeaders, PAGES_PARTITION, type PageViewState } from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import type { ShellLog } from "../../core/log.ts";
import {
  isPageKey,
  pageListenerOrigin,
  pageNavigation,
  pagePrefixOf,
  pageRequest,
} from "../../core/page-rules.ts";
import { parsePreviewBounds, previewsToClose, windowRect } from "../../core/preview-rules.ts";
import type { ShellIpc } from "../ipc.ts";
import { harden } from "../preview/main.ts";

/** How many pages stay loaded; opening another closes the least recently used one not shown. */
export const MAX_PAGES = 4;

/** Chromium's code for a load that was superseded or stopped, which isn't a failure to show. */
const ERR_ABORTED = -3;

/**
 * A proxy nothing listens on: every connection Chromium would make goes to it and fails, WebRTC's
 * TCP to loopback included, should anything pass the request check. Only the page listener's own
 * address is reached directly (`proxyFor`).
 */
const NO_PROXY = "127.0.0.1:9";

/**
 * The session's proxy: `NO_PROXY` for everything, loopback too (`<-loopback>`, which Chromium would
 * otherwise reach directly), but the page listener's exact host and port.
 */
export const proxyFor = (origin: string | undefined) => ({
  mode: "fixed_servers" as const,
  proxyRules: NO_PROXY,
  proxyBypassRules: origin === undefined ? "<-loopback>" : `<-loopback>;${new URL(origin).host}`,
});

/** `headers` with the pages' policy put in place of any header of the same name, whatever its case. */
export function withPagePolicy(
  headers: Record<string, string | string[]> | undefined,
  origin: string,
): Record<string, string[]> {
  const policy = pagePolicyHeaders(origin);
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower in policy || lower === "content-security-policy-report-only") continue;
    out[name] = Array.isArray(value) ? value : [value];
  }
  for (const [name, value] of Object.entries(policy)) out[name] = [value];
  return out;
}

interface PageView {
  readonly key: string;
  /** What every URL of the page this view opened starts with: its token's folder. */
  readonly prefix: string;
  readonly view: WebContentsView;
  window: BrowserWindow | undefined;
  readonly watchers: Set<WebContents>;
  error: string | undefined;
}

export interface PagesOptions {
  readonly log: ShellLog;
  /**
   * The built page guard preload (`guard.ts`), which each frame of a pinned page it reaches runs first and
   * which exposes nothing. Without it no page opens.
   */
  readonly guardPreload: string | undefined;
}

/** What main can reach of the pages: only telling them where the listener is. */
export interface PagesHost {
  /** The page listener's origin, as the server announced it; anything else is ignored. */
  setOrigin(origin: unknown): void;
  /** The session pinned pages run in, for checks; never for an agent. */
  readonly session: () => Session;
}

/** The page an IPC message names, by its `key`. */
const keyOf = (input: unknown): string | undefined => {
  const key: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, "key") : undefined;
  return isPageKey(key) ? key : undefined;
};

/** Serves `window.gram.pages` for every window. */
export function installPages(ipc: ShellIpc, options: PagesOptions): PagesHost {
  let origin: string | undefined;
  /** Each page's view, least recently used first. */
  const views = new Map<string, PageView>();
  /** Every page view's contents, to the prefix it may load. */
  const prefixes = new WeakMap<WebContents, string>();

  let made: Session | undefined;
  /** The proxy for the current origin, set or failed; nothing loads before it is in place. */
  let proxied: Promise<boolean> = Promise.resolve(false);
  const applyProxy = (ses: Session) => {
    proxied = ses.setProxy(proxyFor(origin)).then(
      () => true,
      (error: unknown) => {
        options.log.error({ source: "pages", error: String(error) }, "the pages proxy wasn't set");
        return false;
      },
    );
  };
  const pagesSession = () => {
    if (made !== undefined) return made;
    const ses = session.fromPartition(PAGES_PARTITION);
    harden(ses);
    applyProxy(ses);
    // Every request, the page's own included, is held to the files of the view that made it.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const contents = details.webContents;
      const prefix =
        contents === undefined || contents.isDestroyed() ? undefined : prefixes.get(contents);
      callback(
        pageRequest(prefix, { url: details.url, method: details.method }) === "allow"
          ? {}
          : { cancel: true },
      );
    });
    // The pages' policy on every response, whatever the listener sent: the sandbox and CSP hold
    // even if the server's half didn't.
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (origin === undefined) return callback({ cancel: true });
      callback({ responseHeaders: withPagePolicy(details.responseHeaders, origin) });
    });
    made = ses;
    return ses;
  };

  const stateOf = (page: PageView): PageViewState => ({
    loading: !page.view.webContents.isDestroyed() && page.view.webContents.isLoading(),
    ...(page.error === undefined ? {} : { error: page.error }),
  });

  const report = (page: PageView) => {
    const state = stateOf(page);
    for (const watcher of page.watchers) {
      if (watcher.isDestroyed()) page.watchers.delete(watcher);
      else watcher.send(Channels.pagesState, { key: page.key, state });
    }
  };

  const detach = (page: PageView) => {
    const { window, view } = page;
    if (window === undefined) return;
    page.window = undefined;
    const hadFocus = !view.webContents.isDestroyed() && view.webContents.isFocused();
    view.setVisible(false);
    if (window.isDestroyed()) return;
    window.contentView.removeChildView(view);
    if (hadFocus) window.webContents.focus();
  };

  const close = (page: PageView) => {
    if (views.get(page.key) !== page) return;
    views.delete(page.key);
    detach(page);
    if (!page.view.webContents.isDestroyed()) page.view.webContents.close();
  };

  const watched = new WeakSet<BrowserWindow>();
  const leave = (window: BrowserWindow) => {
    for (const page of views.values()) if (page.window === window) detach(page);
  };
  const attach = (page: PageView, window: BrowserWindow) => {
    if (page.window === window) return;
    detach(page);
    page.window = window;
    window.contentView.addChildView(page.view);
    if (watched.has(window)) return;
    watched.add(window);
    window.webContents.on("did-navigate", () => leave(window));
    window.once("closed", () => leave(window));
  };

  const create = (key: string, prefix: string): PageView => {
    const view = new WebContentsView({
      webPreferences: {
        session: pagesSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // The guard, in each frame the preload reaches; sandboxed, so no Node. A child the page
        // makes itself gets none, and is out of the page's reach by the sandbox's opaque origins.
        ...(options.guardPreload === undefined ? {} : { preload: options.guardPreload }),
        nodeIntegrationInSubFrames: true,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        autoplayPolicy: "user-gesture-required",
      },
    });
    view.setVisible(false);
    const contents = view.webContents;
    // WebRTC's sockets don't pass the request check: no UDP at all, and TCP only through the
    // session's proxy, which goes nowhere.
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    prefixes.set(contents, prefix);
    const page: PageView = {
      key,
      prefix,
      view,
      window: undefined,
      watchers: new Set(),
      error: undefined,
    };
    contents.once("destroyed", () => {
      if (views.get(key) === page) views.delete(key);
    });
    // No popup, and no link question: nothing a page does asks to go anywhere.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const stay = (event: { preventDefault(): void; url: string }) => {
      if (pageNavigation(prefix, event.url) === "load") return;
      event.preventDefault();
    };
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("will-frame-navigate", stay);
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) page.error = undefined;
    });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      page.error = description === "" ? `Error ${code}` : description;
      report(page);
    });
    contents.on("render-process-gone", (_event, details) => {
      page.error = `the page stopped (${details.reason})`;
      report(page);
    });
    contents.on("did-start-loading", () => report(page));
    contents.on("did-stop-loading", () => report(page));

    const shown = (id: string) => views.get(id)?.window !== undefined;
    for (const id of previewsToClose([...views.keys()], shown, MAX_PAGES - 1)) {
      const old = views.get(id);
      if (old !== undefined) close(old);
    }
    views.set(key, page);
    return page;
  };

  const touch = (page: PageView) => {
    views.delete(page.key);
    views.set(page.key, page);
  };

  ipc.handle(Channels.pagesOpen, async (input, event) => {
    const key = keyOf(input);
    const url: unknown =
      typeof input === "object" && input !== null ? Reflect.get(input, "url") : undefined;
    const prefix = pagePrefixOf(origin, url);
    if (key === undefined || prefix === undefined || typeof url !== "string") return false;
    if (options.guardPreload === undefined) return false;
    pagesSession();
    if (!(await proxied)) return false;
    const known = views.get(key);
    // Another version is another folder: a fresh view, with nothing of the old one's state.
    let page = known;
    if (known !== undefined && known.prefix !== prefix) {
      const { window } = known;
      const watchers = [...known.watchers];
      close(known);
      page = create(key, prefix);
      for (const watcher of watchers) page.watchers.add(watcher);
      if (window !== undefined) attach(page, window);
    }
    page ??= create(key, prefix);
    touch(page);
    page.watchers.add(event.sender);
    page.error = undefined;
    await page.view.webContents.loadURL(url).catch(() => {});
    report(page);
    return true;
  });
  ipc.on(Channels.pagesBounds, (event, input) => {
    const key = keyOf(input);
    const page = key === undefined ? undefined : views.get(key);
    const window = BrowserWindow.fromWebContents(event.sender);
    const bounds = parsePreviewBounds(
      typeof input === "object" && input !== null ? Reflect.get(input, "bounds") : undefined,
    );
    if (page === undefined || window === null || bounds === undefined) return;
    page.watchers.add(event.sender);
    if (bounds === null || bounds.width === 0 || bounds.height === 0) {
      if (page.window === window) detach(page);
      return;
    }
    touch(page);
    attach(page, window);
    page.view.setBounds(windowRect(bounds, event.sender.getZoomFactor()));
    page.view.setVisible(true);
  });
  ipc.on(Channels.pagesReload, (_event, input) => {
    const key = keyOf(input);
    const page = key === undefined ? undefined : views.get(key);
    if (page === undefined || page.view.webContents.isDestroyed()) return;
    page.error = undefined;
    page.view.webContents.reload();
  });
  ipc.on(Channels.pagesClose, (_event, input) => {
    const key = keyOf(input);
    const page = key === undefined ? undefined : views.get(key);
    if (page !== undefined) close(page);
  });

  return {
    setOrigin: (raw) => {
      const next = pageListenerOrigin(raw);
      if (next === undefined) {
        options.log.warn({ source: "pages" }, "the page listener's origin wasn't one to load");
        return;
      }
      if (next === origin) return;
      origin = next;
      if (made !== undefined) applyProxy(made);
      // A restarted server serves from another port: what was open came from the old one, and
      // the tab opens it again from the new one.
      for (const page of views.values()) {
        page.error = "Gram restarted";
        report(page);
        close(page);
      }
    },
    session: pagesSession,
  };
}

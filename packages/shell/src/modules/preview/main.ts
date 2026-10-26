// The preview module's main half: each thread's Preview tab page, one `WebContentsView` per thread,
// drawn over the tab's placeholder in whichever window shows it and kept loaded, in no window, while
// none does, for the `MAX_PREVIEWS` most recently used threads. It is the only web content the
// shell shows that isn't the app's own, so it gets nothing of the app's: a session of its own kept in
// memory, no preload, no permission, no download, no client certificate, and no request off loopback
// (`core/preview-rules.ts`). A link off loopback goes to the shell's link question instead, and so
// does every new window.

import {
  app,
  BrowserWindow,
  session,
  WebContentsView,
  type Session,
  type WebContents,
} from "electron";

import {
  loopbackUrl,
  type BrowserInspection,
  type BrowserRegion,
  type BrowserViewportPreset,
  type PaneResult,
  type PreviewState,
} from "@gram/contracts/link-trust";

import { Channels } from "../../channels.ts";
import type { ShellLog } from "../../core/log.ts";
import {
  MAX_PREVIEWS,
  parsePreviewBounds,
  previewNavigation,
  previewRequest,
  previewsToClose,
  previewThreadOf,
  windowRect,
} from "../../core/preview-rules.ts";
import { parsePaneCommand } from "../../core/browse-rules.ts";
import type { ShellIpc } from "../ipc.ts";

/** No `persist:` prefix, so its cookies and storage live in memory and are gone at quit. */
const PARTITION = "gram-preview";

/** The size an agent's page lays out at until a window shows it, a laptop's usual pane. */
const AGENT_PAGE_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 } as const;

/** Chromium's code for a load that was superseded or stopped, which isn't a failure to show. */
const ERR_ABORTED = -3;

/** What the preview needs from the app that installs it. */
export interface PreviewOptions {
  /** Opens a link off loopback (or a new window) through the shell's link question. */
  readonly openLink: (url: string, window: BrowserWindow) => Promise<boolean>;
  readonly log: ShellLog;
  /** Agents' pages (`modules/agent-browser`), asked before an agent's page goes anywhere. */
  readonly agent?: PreviewAgent | undefined;
}

/**
 * What the preview asks of the agent browser about a thread's page. Each question answers
 * `undefined` for a page no agent drives, or for a URL the preview's own rules decide: loopback,
 * and a link the user follows off it.
 */
/** One request of a preview's page, as `webRequest.onBeforeRequest` reports it. */
export interface PreviewRequestDetails {
  /** The same for each hop of one request's redirects. */
  readonly id: number;
  readonly url: string;
  readonly method: string;
  readonly mainFrame: boolean;
  /** A frame inside the page navigating, which a form can target as well as the page itself. */
  readonly subFrame: boolean;
  /** The origin of the page that started it; absent for a load the app itself started. */
  readonly initiator?: string | undefined;
}

export interface PreviewAgent {
  /** Whether a main-frame navigation of an agent's page loads, or is stopped. */
  navigation(contents: WebContents, url: string): "load" | "block" | undefined;
  /** Whether one request of an agent's page goes out, as the session's `webRequest` sees it. */
  request(
    contents: WebContents,
    details: PreviewRequestDetails,
  ): Promise<"allow" | "block"> | undefined;
  /** The user put input into `contents`. */
  userInput(contents: WebContents): void;
  /** Who drives the thread's page, once its agent has used it. */
  driverOf(threadId: string): "agent" | "user" | undefined;
  actionOf?(threadId: string): { readonly summary: string; readonly at: number } | undefined;
  recordingOf?(threadId: string): boolean;
  handBack(threadId: string): void;
  takeOver(threadId: string): void;
  inspectionOf(threadId: string): BrowserInspection | undefined;
  inspect(threadId: string, target?: { ref?: string; region?: BrowserRegion }): Promise<PaneResult>;
  viewport(threadId: string, preset: BrowserViewportPreset): Promise<PaneResult>;
}

interface Preview {
  readonly threadId: string;
  readonly view: WebContentsView;
  /** The window whose Preview tab shows the page; `undefined` while none does. */
  window: BrowserWindow | undefined;
  /** The app pages that asked about this thread's page, told each time it changes. */
  readonly watchers: Set<WebContents>;
  error: string | undefined;
}

/** What main can reach of the previews, for tools that act on a page from the main process. */
export interface PreviewHost {
  /** `threadId`'s page, while it has one: loaded, shown in a window or not. */
  contentsOf(threadId: string): WebContents | undefined;
  /** As `contentsOf`, making the page, blank and out of sight, when `create` and there is none. */
  contentsFor(threadId: string, create: boolean): WebContents | undefined;
  /** Tells the windows watching `threadId`'s page that it changed, as its driver does. */
  changed(threadId: string): void;
}

/** Serves `window.gram.preview` for every window. */
export function installPreview(ipc: ShellIpc, options: PreviewOptions): PreviewHost {
  /** Each thread's preview, least recently used first. */
  const previews = new Map<string, Preview>();
  const previewContents = new WeakSet<WebContents>();
  let previewSession: Session | undefined;

  // Electron picks the first certificate in the store when nobody answers, which on a managed
  // laptop can be the device's own, the one that signs in to internal sites.
  app.on("select-client-certificate", (event, contents, _url, _list, callback) => {
    if (contents === null || !previewContents.has(contents)) return;
    event.preventDefault();
    callback();
  });

  const sessionOf = (): Session => {
    if (previewSession !== undefined) return previewSession;
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setSpellCheckerEnabled(false);
    ses.on("will-download", (event) => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
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
          (verdict) => callback(verdict === "allow" ? {} : { cancel: true }),
          () => callback({ cancel: true }),
        );
        return;
      }
      callback(previewRequest(details.url) === "allow" ? {} : { cancel: true });
    });
    previewSession = ses;
    return ses;
  };

  const stateOf = (preview: Preview): PreviewState | null => {
    const contents = preview.view.webContents;
    if (contents.isDestroyed()) return null;
    const url = contents.getURL();
    if (url === "") return null;
    const driver = options.agent?.driverOf(preview.threadId);
    const browserInspection = options.agent?.inspectionOf(preview.threadId);
    const action = options.agent?.actionOf?.(preview.threadId);
    const recording = options.agent?.recordingOf?.(preview.threadId) === true;
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

  const create = (threadId: string): Preview => {
    const view = new WebContentsView({
      webPreferences: {
        session: sessionOf(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setVisible(false);
    const preview: Preview = {
      threadId,
      view,
      window: undefined,
      watchers: new Set(),
      error: undefined,
    };
    const contents = view.webContents;
    previewContents.add(contents);
    contents.once("destroyed", () => {
      if (previews.get(threadId) === preview) previews.delete(threadId);
    });

    const send = () => report(preview);
    const toLinkGate = (url: string) => {
      const window = preview.window ?? BrowserWindow.getFocusedWindow();
      if (window !== null && !window.isDestroyed()) void options.openLink(url, window);
    };
    contents.setWindowOpenHandler(({ url }) => {
      toLinkGate(url);
      return { action: "deny" };
    });
    const steer = (event: { preventDefault(): void }, url: string) => {
      const agentSays = options.agent?.navigation(contents, url);
      if (agentSays === "load") return;
      if (agentSays === "block") {
        event.preventDefault();
        return;
      }
      const decision = previewNavigation(url);
      if (decision === "load") return;
      event.preventDefault();
      if (decision === "external") toLinkGate(url);
    };
    contents.on("will-navigate", (event) => {
      if (event.isMainFrame) steer(event, event.url);
    });
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) steer(event, event.url);
    });
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) preview.error = undefined;
    });
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
    contents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown") options.agent?.userInput(contents);
    });
    contents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseDown" || mouse.type === "mouseWheel")
        options.agent?.userInput(contents);
    });
    contents.on("did-start-loading", send);
    contents.on("did-stop-loading", send);
    contents.on("did-navigate", send);
    contents.on("did-navigate-in-page", send);
    contents.on("page-title-updated", send);

    // Room for this one first, so the cap holds even while every other preview is shown.
    const shown = (id: string) => previews.get(id)?.window !== undefined;
    for (const id of previewsToClose([...previews.keys()], shown, MAX_PREVIEWS - 1)) {
      const old = previews.get(id);
      if (old !== undefined) close(old);
    }
    previews.set(threadId, preview);
    return preview;
  };

  /** The preview `input` names, telling `sender` about it from now on. */
  const previewFor = (input: unknown, sender: WebContents): Preview | undefined => {
    const threadId = previewThreadOf(input);
    const preview = threadId === undefined ? undefined : previews.get(threadId);
    preview?.watchers.add(sender);
    return preview;
  };

  ipc.handle(Channels.previewOpen, async (input, event) => {
    const threadId = previewThreadOf(input);
    const raw: unknown = threadId === undefined ? undefined : Reflect.get(input as object, "url");
    const url = typeof raw === "string" ? loopbackUrl(raw) : undefined;
    if (threadId === undefined || url === undefined) return false;
    const preview = previews.get(threadId) ?? create(threadId);
    touch(preview);
    preview.watchers.add(event.sender);
    preview.error = undefined;
    // A page that won't load rejects here and reports itself through `did-fail-load`.
    await preview.view.webContents.loadURL(url).catch(() => {});
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
    preview.view.setBounds(windowRect(bounds, event.sender.getZoomFactor()));
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
  ipc.on(Channels.previewHandBack, (event, input) => {
    const threadId = previewFor(input, event.sender)?.threadId;
    if (threadId !== undefined) options.agent?.handBack(threadId);
  });
  ipc.on(Channels.previewTakeOver, (event, input) => {
    const threadId = previewFor(input, event.sender)?.threadId;
    if (threadId !== undefined) options.agent?.takeOver(threadId);
  });
  const unavailable: PaneResult = {
    ok: false,
    code: "noPane",
    message: "Browser inspection unavailable here.",
  };
  ipc.handle(Channels.previewInspect, (input, event) => {
    const preview = previewFor(input, event.sender);
    const target =
      typeof input === "object" && input !== null ? Reflect.get(input, "target") : undefined;
    const command = parsePaneCommand({
      op: "screenshot",
      ...(typeof target === "object" && target !== null ? target : {}),
    });
    if (preview === undefined || command?.op !== "screenshot") return unavailable;
    return (
      options.agent?.inspect(preview.threadId, {
        ...(command.ref === undefined ? {} : { ref: command.ref }),
        ...(command.region === undefined ? {} : { region: command.region }),
      }) ?? unavailable
    );
  });
  ipc.handle(Channels.previewViewport, (input, event) => {
    const preview = previewFor(input, event.sender);
    const preset =
      typeof input === "object" && input !== null ? Reflect.get(input, "preset") : undefined;
    const command = parsePaneCommand({ op: "viewport", preset });
    if (preview === undefined || command?.op !== "viewport" || command.preset === undefined)
      return unavailable;
    return options.agent?.viewport(preview.threadId, command.preset) ?? unavailable;
  });
  ipc.handle(Channels.previewStateGet, (input, event) => {
    const preview = previewFor(input, event.sender);
    return preview === undefined ? null : stateOf(preview);
  });

  const contentsOf = (threadId: string) => {
    const contents = previews.get(threadId)?.view.webContents;
    return contents === undefined || contents.isDestroyed() ? undefined : contents;
  };
  return {
    contentsOf,
    contentsFor: (threadId, make) => {
      const existing = contentsOf(threadId);
      if (existing !== undefined || !make) return existing;
      const preview = create(threadId);
      touch(preview);
      // A page no window has shown yet has no size, and lays out, hit-tests and captures nothing.
      preview.view.setBounds(AGENT_PAGE_BOUNDS);
      return preview.view.webContents;
    },
    changed: (threadId) => {
      const preview = previews.get(threadId);
      if (preview !== undefined) report(preview);
    },
  };
}

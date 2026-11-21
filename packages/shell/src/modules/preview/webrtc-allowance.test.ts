import { EventEmitter } from "node:events";
import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ShellIpc } from "../ipc.ts";

// The preview module over fake Electron: pages are event emitters that record what they load, and
// sessions record their partition and whether their storage was cleared.

interface FakeSession {
  readonly partition: string;
  readonly cleared: string[];
}

const sessions = new Map<string, FakeSession>();
const fakeSession = (partition: string) => {
  const known = sessions.get(partition);
  if (known !== undefined) return known;
  const cleared: string[] = [];
  const ses = {
    partition,
    cleared,
    webRequest: { onBeforeRequest: () => undefined },
    setProxy: async () => undefined,
    setPermissionRequestHandler: () => undefined,
    setPermissionCheckHandler: () => undefined,
    setDevicePermissionHandler: () => undefined,
    setSpellCheckerEnabled: () => undefined,
    on: () => undefined,
    clearStorageData: async () => void cleared.push("storage"),
    clearCache: async () => void cleared.push("cache"),
  };
  sessions.set(partition, ses);
  return ses;
};

let contentsIds = 0;
class FakeContents extends EventEmitter {
  readonly id = (contentsIds += 1);
  url = "";
  destroyed = false;
  readonly loads: string[] = [];
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  readonly session: FakeSession;
  constructor(session: FakeSession) {
    super();
    this.session = session;
  }
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getTitle = () => "";
  isLoading = () => false;
  isFocused = () => false;
  setWindowOpenHandler = () => undefined;
  setWebRTCIPHandlingPolicy = () => undefined;
  loadURL = async (url: string) => {
    this.loads.push(url);
    this.url = url;
  };
  close = () => {
    this.destroyed = true;
    this.emit("destroyed");
  };
}

vi.mock("electron", () => ({
  app: { on: () => undefined, once: () => undefined },
  BrowserWindow: { fromWebContents: () => null },
  session: { fromPartition: (partition: string) => fakeSession(partition) },
  WebContentsView: class {
    readonly webContents: FakeContents;
    constructor(options: { webPreferences: { session: FakeSession } }) {
      this.webContents = new FakeContents(options.webPreferences.session);
    }
    setVisible() {}
    setBounds() {}
  },
}));
vi.mock("../../core/web-proxy.ts", () => ({
  boundedLookup: async () => [],
  systemLookup: async () => [],
  startWebProxy: async () => ({
    realm: "r",
    port: 9,
    username: "u",
    password: "p",
    close: () => {},
  }),
}));
// Each page's guard is the WebRTC guard's own tests'; here a page made guarded says so.
const guarded = new Set<unknown>();
vi.mock("./webrtc-guard.ts", () => ({
  guardWebRtc: async (contents: unknown) => {
    guarded.add(contents);
    return true;
  },
  heldForGuard: (listener: unknown) => listener,
  webRtcGuardHeld: () => undefined,
}));
vi.mock("../../electron/decision-windows.ts", () => ({
  focusedAppWindow: () => ({ isDestroyed: () => false }),
}));

const { installPreview } = await import("./main.ts");
const { Channels } = await import("../../channels.ts");

const PAGE = "http://localhost:5173/";
const APP = "http://127.0.0.1:4317";
const FILES = "http://127.0.0.1:40123";

const setUp = () => {
  const handlers = new Map<string, Parameters<ShellIpc["handle"]>[1]>();
  const ipc: ShellIpc = {
    on: () => undefined,
    handle: (channel, handler) => void handlers.set(channel, handler),
  };
  const sender = { send: () => {}, isDestroyed: () => false, getZoomFactor: () => 1 };
  const invoke = (channel: string, arg: object) =>
    handlers.get(channel)!(arg, { sender } as unknown as IpcMainInvokeEvent);
  const drivers = new Map<string, "agent" | "user">();
  const links: string[] = [];
  const host = installPreview(ipc, {
    openLink: async (url) => {
      links.push(url);
      return false;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} } as never,
    appOrigins: () => [APP],
    agent: {
      navigation: () => undefined,
      request: () => undefined,
      userInput: () => {},
      driverOf: (threadId) => drivers.get(threadId),
      isAppPage: (_threadId, url) => new URL(url).origin === FILES,
      handBack: () => {},
      takeOver: () => {},
      inspectionOf: () => undefined,
      inspect: async () => ({ ok: false, code: "noPane", message: "none" }) as never,
      viewport: async () => ({ ok: false, code: "noPane", message: "none" }) as never,
    },
  });
  const open = (url: string, typed?: boolean) =>
    invoke(Channels.previewOpen, { threadId: "t", url, ...(typed ? { typed } : {}) });
  const allow = (allowed = true) =>
    invoke(Channels.previewSetWebRtc, { threadId: "t", allowed }) as Promise<boolean>;
  const state = () =>
    invoke(Channels.previewStateGet, { threadId: "t" }) as {
      webRtc?: boolean;
      webRtcOffered?: boolean;
    } | null;
  const page = () => host.contentsOf("t") as unknown as FakeContents;
  return { host, open, allow, state, page, drivers, links };
};

beforeEach(() => {
  sessions.clear();
  guarded.clear();
});

describe("the user's WebRTC switch", () => {
  it("goes on for an address the user typed, in a page of its own with nothing in it", async () => {
    const preview = setUp();
    await preview.open(PAGE, true);
    expect(preview.state()?.webRtcOffered).toBe(true);
    const before = preview.page();
    expect(await preview.allow()).toBe(true);
    const after = preview.page();
    expect(after).not.toBe(before);
    expect(guarded.has(after)).toBe(false);
    expect(after.loads).toEqual([PAGE]);
    expect(preview.state()?.webRtc).toBe(true);
    // Not the session every other local page shares, an agent's included, and emptied first.
    expect(after.session.partition).toBe("gram-preview-webrtc-1");
    expect(after.session.cleared).toEqual(expect.arrayContaining(["storage", "cache"]));
    expect(before.session.partition).toBe("gram-preview");
    // Off again: back in the shared session, guarded, and the switch still offered.
    expect(await preview.allow(false)).toBe(true);
    expect(guarded.has(preview.page())).toBe(true);
    expect(preview.page().session.partition).toBe("gram-preview");
    expect(preview.state()).toMatchObject({ webRtcOffered: true });
    expect(preview.state()?.webRtc).toBeUndefined();
  });

  it("is refused on a page the user didn't type: a port chip's, or an agent's `show_panel`", async () => {
    const preview = setUp();
    await preview.open(PAGE);
    expect(preview.state()?.webRtcOffered).toBeUndefined();
    expect(await preview.allow()).toBe(false);
    expect(guarded.has(preview.page())).toBe(true);
  });

  it("is refused on Gram's own pages: a file preview, the app's origin", async () => {
    for (const url of [
      `${FILES}/gram-preview-files/tok/index.html`,
      `${FILES}/other.html`,
      "http://127.0.0.1:9/gram-preview-files/tok/index.html",
      `${APP}/`,
    ]) {
      const preview = setUp();
      await preview.open(url, true);
      expect(preview.state()?.webRtcOffered, url).toBeUndefined();
      expect(await preview.allow(), url).toBe(false);
    }
  });

  it("is refused once the page left the typed origin, while an agent drives, or after one had it", async () => {
    const moved = setUp();
    await moved.open(PAGE, true);
    // A link to another loopback origin, in the same page.
    await moved.page().loadURL("http://localhost:8080/");
    expect(await moved.allow()).toBe(false);

    const driven = setUp();
    await driven.open(PAGE, true);
    driven.drivers.set("t", "agent");
    expect(driven.state()?.webRtcOffered).toBeUndefined();
    expect(await driven.allow()).toBe(false);

    // The agent was handed the page, and the user then clicked in: still the agent's page.
    const taken = setUp();
    await taken.open(PAGE, true);
    expect(await taken.host.contentsFor("t", true)).toBe(taken.host.contentsOf("t"));
    taken.drivers.set("t", "user");
    expect(await taken.allow()).toBe(false);
  });

  it("an agent's peek gets no page and leaves the user's as it is; taking it ends WebRTC", async () => {
    const preview = setUp();
    await preview.open(PAGE, true);
    await preview.allow();
    const theirs = preview.page();
    expect(await preview.host.contentsFor("t", false)).toBeUndefined();
    expect(preview.page()).toBe(theirs);
    expect(preview.state()?.webRtc).toBe(true);

    const taken = await preview.host.contentsFor("t", true);
    expect(taken).toBeDefined();
    expect(taken).not.toBe(theirs);
    expect(guarded.has(taken)).toBe(true);
    expect(preview.state()?.webRtc).toBeUndefined();
    expect(preview.state()?.webRtcOffered).toBeUndefined();
  });

  it("anything else opening in the thread makes the page again guarded, with no switch", async () => {
    const preview = setUp();
    await preview.open(PAGE, true);
    await preview.allow();
    const theirs = preview.page();
    await preview.open(PAGE);
    expect(preview.page()).not.toBe(theirs);
    expect(guarded.has(preview.page())).toBe(true);
    expect(preview.page().session.partition).toBe("gram-preview");
    expect(preview.state()?.webRtc).toBeUndefined();
    expect(preview.state()?.webRtcOffered).toBeUndefined();
  });

  it("a link off loopback from a page with WebRTC goes to the link question", async () => {
    const preview = setUp();
    await preview.open(PAGE, true);
    await preview.allow();
    const theirs = preview.page();
    const event = { isMainFrame: true, url: "https://example.com/", preventDefault: vi.fn() };
    theirs.emit("will-navigate", event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(preview.links).toEqual(["https://example.com/"]);
    // It stays where it was, with WebRTC: the link didn't leave.
    expect(preview.page()).toBe(theirs);
  });
});

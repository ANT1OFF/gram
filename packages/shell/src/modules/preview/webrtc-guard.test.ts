import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import {
  DROP_WEBRTC,
  guardWebRtc,
  heldForGuard,
  WEBRTC_NAMES,
  webRtcGuardDown,
} from "./webrtc-guard.ts";

/** What the guard sends a session to put itself in place there. */
const INSTALL = [
  "Page.enable",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.setPrerenderingAllowed",
  "Target.setAutoAttach",
];

let pages = 0;

/** A page that has loaded nothing yet, with a debugger that records what it was sent. */
const fakePage = () => {
  const cdp = new EventEmitter();
  const sent: { method: string; params?: object | undefined; sessionId?: string | undefined }[] =
    [];
  let attached = false;
  let url = "";
  let destroyed = false;
  const contents = {
    id: (pages += 1),
    isDestroyed: () => destroyed,
    getURL: () => url,
    loadURL: async (next: string) => {
      sent.push({ method: `load ${next}` });
      url = next;
    },
    debugger: Object.assign(cdp, {
      isAttached: () => attached,
      attach: () => {
        if (attached) throw new Error("Another debugger is already attached");
        attached = true;
        sent.push({ method: "attach" });
      },
      sendCommand: async (method: string, params?: object, sessionId?: string) => {
        if (!attached) throw new Error("not attached");
        sent.push({ method, params, sessionId });
        return {};
      },
    }),
  };
  const detach = () => {
    attached = false;
    cdp.emit("detach", {}, "target closed");
  };
  const destroy = () => {
    destroyed = true;
    detach();
  };
  return { contents, cdp, sent, detach, destroy };
};

/** What a page's WebRTC constructor stands for. */
function native() {}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const warn = () => {};

describe("the WebRTC guard", () => {
  // Chromium looks up an ICE server's or a remote candidate's name past every control a session
  // has, so a page with WebRTC could send what it holds out in DNS queries.
  it("leaves no document WebRTC", () => {
    const world: Record<string, unknown> = {};
    for (const name of WEBRTC_NAMES) world[name] = native;
    runInNewContext(DROP_WEBRTC, world);
    for (const name of WEBRTC_NAMES)
      expect(runInNewContext(`typeof globalThis[${JSON.stringify(name)}]`, world)).toBe(
        "undefined",
      );
  });

  // A preload never reaches a child the page makes at `about:blank`; the protocol's new-document
  // script does, and every other target waits for it.
  it("is in place in every document before the page loads anything", async () => {
    const page = fakePage();
    const ready = guardWebRtc(page.contents, warn);
    expect(webRtcGuardDown(page.contents)).toBe(true);
    expect(await ready).toBe(true);
    expect(webRtcGuardDown(page.contents)).toBe(false);
    expect(page.sent.map(({ method }) => method)).toEqual([
      "load about:blank",
      "attach",
      ...INSTALL,
    ]);
    expect(page.sent[3]?.params).toEqual({ source: DROP_WEBRTC, runImmediately: true });
    expect(page.sent[4]?.params).toEqual({ isAllowed: false });
    expect(page.sent[5]?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  });

  // A prerendered page is a target of type "page"; only workers, which have no WebRTC, go as is.
  it("lets every target but a worker run only once it has the guard too", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.sent.length = 0;
    const targets = ["iframe", "page", "other", "worker", "service_worker", "shared_worker"];
    for (const type of targets)
      page.cdp.emit("message", {}, "Target.attachedToTarget", {
        sessionId: type,
        targetInfo: { type },
      });
    await settle();
    const sentTo = (id: string) =>
      page.sent.filter(({ sessionId }) => sessionId === id).map((s) => s.method);
    for (const type of ["iframe", "page", "other"])
      expect(sentTo(type)).toEqual([...INSTALL, "Runtime.runIfWaitingForDebugger"]);
    for (const type of ["worker", "service_worker", "shared_worker"])
      expect(sentTo(type)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });

  it("loads nothing between a detach and its own attach again", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.sent.length = 0;
    page.detach();
    expect(webRtcGuardDown(page.contents)).toBe(true);
    await settle();
    expect(webRtcGuardDown(page.contents)).toBe(false);
    expect(page.sent.map(({ method }) => method)).toEqual(["attach", ...INSTALL]);
    page.sent.length = 0;
    page.destroy();
    await settle();
    expect(page.sent).toEqual([]);
  });

  // Another user of the debugger may detach it twice before the guard is back: it still comes back.
  it("comes back after detaches in quick succession", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.detach();
    await Promise.resolve();
    page.detach();
    await settle();
    await settle();
    expect(webRtcGuardDown(page.contents)).toBe(false);
    expect(page.contents.debugger.isAttached()).toBe(true);
  });

  // Closing a page detaches its debugger, and each attach after that detaches at once.
  it("lets a page that is closing go, blanked", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.sent.length = 0;
    let attaches = 0;
    page.contents.debugger.attach = () => {
      attaches += 1;
      if (attaches > 50) throw new Error("attached again and again");
      page.detach();
    };
    page.detach();
    await settle();
    // A few tries, then it stops.
    expect(attaches).toBe(5);
    expect(webRtcGuardDown(page.contents)).toBe(true);
    expect(page.sent.map(({ method }) => method)).toContain("load about:blank");
  });

  it("blanks a page it can't attach to again, and keeps it loading nothing", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.sent.length = 0;
    page.contents.debugger.attach = () => {
      throw new Error("Another debugger is already attached");
    };
    page.detach();
    await settle();
    expect(webRtcGuardDown(page.contents)).toBe(true);
    expect(page.sent.map(({ method }) => method)).toEqual(["load about:blank"]);
  });

  // The session's request check: a page's requests wait while the removal is away.
  it("holds a page's requests until it is back, and refuses them in a page given up", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    const answers: string[] = [];
    const check = heldForGuard<{ webContents: { id: number }; url: string }>(
      (details, callback) => {
        answers.push(`checked ${details.url}`);
        callback({});
      },
    );
    const ask = (url: string) =>
      check({ webContents: page.contents, url }, (response) =>
        answers.push(response.cancel === true ? `refused ${url}` : `answered ${url}`),
      );
    page.detach();
    ask("during");
    expect(answers).toEqual([]);
    await settle();
    expect(answers).toEqual(["checked during", "answered during"]);
    page.contents.debugger.attach = () => {
      throw new Error("Another debugger is already attached");
    };
    page.detach();
    ask("after");
    await settle();
    expect(answers.slice(2)).toEqual(["refused after"]);
  });

  it("lets nothing load in a page it couldn't guard", async () => {
    const page = fakePage();
    page.contents.debugger.attach = () => {
      throw new Error("Another debugger is already attached");
    };
    page.contents.debugger.isAttached = () => false;
    expect(await guardWebRtc(page.contents, warn)).toBe(false);
    expect(webRtcGuardDown(page.contents)).toBe(true);
  });
});

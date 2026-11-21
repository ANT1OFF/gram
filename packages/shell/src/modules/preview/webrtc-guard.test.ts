import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { DROP_WEBRTC, guardWebRtc, WEBRTC_NAMES } from "./webrtc-guard.ts";

/** A page that has loaded nothing yet, with a debugger that records what it was sent. */
const fakePage = () => {
  const cdp = new EventEmitter();
  const sent: { method: string; params?: object | undefined; sessionId?: string | undefined }[] =
    [];
  let attached = false;
  let url = "";
  let destroyed = false;
  const contents = {
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
  // script does, and every out-of-process frame waits for it.
  it("is in place in every document before the page loads anything", async () => {
    const page = fakePage();
    expect(await guardWebRtc(page.contents, warn)).toBe(true);
    expect(page.sent.map(({ method }) => method)).toEqual([
      "load about:blank",
      "attach",
      "Page.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Target.setAutoAttach",
    ]);
    expect(page.sent[3]?.params).toEqual({ source: DROP_WEBRTC, runImmediately: true });
    expect(page.sent[4]?.params).toEqual({
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  });

  it("lets an out-of-process frame run only once it has the guard too", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.sent.length = 0;
    page.cdp.emit("message", {}, "Target.attachedToTarget", {
      sessionId: "frame",
      targetInfo: { type: "iframe" },
    });
    page.cdp.emit("message", {}, "Target.attachedToTarget", {
      sessionId: "worker",
      targetInfo: { type: "worker" },
    });
    await settle();
    const frame = page.sent.filter(({ sessionId }) => sessionId === "frame").map((s) => s.method);
    expect(frame).toEqual([
      "Page.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Target.setAutoAttach",
      "Runtime.runIfWaitingForDebugger",
    ]);
    const worker = page.sent.filter(({ sessionId }) => sessionId === "worker").map((s) => s.method);
    expect(worker).toEqual(["Runtime.runIfWaitingForDebugger"]);
  });

  // The agent browser's pane shares the page's debugger and lets it go when the agent is done.
  it("puts itself back when something else detaches the page's debugger", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    page.sent.length = 0;
    page.detach();
    await settle();
    expect(page.sent.map(({ method }) => method)).toEqual([
      "attach",
      "Page.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Target.setAutoAttach",
    ]);
    page.sent.length = 0;
    page.destroy();
    await settle();
    expect(page.sent).toEqual([]);
  });

  // Closing a page detaches its debugger, and each attach after that detaches at once.
  it("lets a page that is closing go", async () => {
    const page = fakePage();
    await guardWebRtc(page.contents, warn);
    let attaches = 0;
    page.contents.debugger.attach = () => {
      attaches += 1;
      if (attaches > 5) throw new Error("attached again and again");
      page.detach();
    };
    page.detach();
    await settle();
    expect(attaches).toBe(1);
  });

  it("lets nothing load in a page it couldn't guard", async () => {
    const page = fakePage();
    page.contents.debugger.attach = () => {
      throw new Error("Another debugger is already attached");
    };
    page.contents.debugger.isAttached = () => false;
    expect(await guardWebRtc(page.contents, warn)).toBe(false);
  });
});

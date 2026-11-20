import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { pageGuard } from "./guard.ts";

const WEBRTC = [
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceCandidate",
  "RTCSessionDescription",
];

/** A page's main world with what the guard takes hold of, and WebRTC, as Chromium gives it. */
const pageWorld = () => {
  class EventTarget {
    addEventListener() {}
  }
  class Event {
    stopImmediatePropagation() {}
  }
  class KeyboardEvent extends Event {
    get key() {
      return "";
    }
    get code() {
      return "";
    }
    get ctrlKey() {
      return false;
    }
    get metaKey() {
      return false;
    }
    get altKey() {
      return false;
    }
  }
  class Document {
    execCommand() {
      return true;
    }
  }
  const world: Record<string, unknown> = {
    Document,
    Event,
    EventTarget,
    KeyboardEvent,
    window: new EventTarget(),
  };
  for (const name of WEBRTC) world[name] = { native: name };
  return world;
};

describe("the pinned page guard", () => {
  // WebRTC looks up an ICE server's or a remote candidate's host name past every control of the
  // session, so a page with it could send data out in DNS queries.
  it("leaves the page no WebRTC to start", () => {
    const world = pageWorld();
    runInNewContext(`(${pageGuard.toString()})();`, world);
    for (const name of WEBRTC)
      expect(runInNewContext(`typeof globalThis[${JSON.stringify(name)}]`, world)).toBe(
        "undefined",
      );
  });
});

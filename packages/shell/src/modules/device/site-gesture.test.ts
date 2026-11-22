import { describe, expect, it } from "vitest";
import {
  fromSitePage,
  makeSiteGestures,
  SITE_GESTURE_MS,
  SITE_GRANTS_PER_MINUTE,
  siteThreadIdOf,
  siteTitle,
  staysIn,
} from "./site-gesture.ts";

// A hosted site's page is the server's code: it may ask for a turn grant only right after the
// person pressed Enter or clicked in its window, once for each, and only from its own top page.
describe("a hosted site's turn grant", () => {
  it("is had once for each Enter or click, soon after it", () => {
    let time = 1_000;
    const gestures = makeSiteGestures(() => time);
    expect(gestures.take()).toBe(false);
    gestures.input({ type: "keyDown", key: "Enter" });
    expect(gestures.take()).toBe(true);
    expect(gestures.take()).toBe(false);
    gestures.pointer();
    time += SITE_GESTURE_MS + 1;
    expect(gestures.take()).toBe(false);
    gestures.pointer();
    time += SITE_GESTURE_MS;
    expect(gestures.take()).toBe(true);
  });

  it("isn't had for other keys, a held Enter, a new line, or a key let go", () => {
    const gestures = makeSiteGestures(() => 0);
    gestures.input({ type: "keyDown", key: "a" });
    gestures.input({ type: "keyUp", key: "Enter" });
    gestures.input({ type: "keyDown", key: "Enter", isAutoRepeat: true });
    gestures.input({ type: "keyDown", key: "Enter", shift: true });
    gestures.input({ type: "keyDown", key: "Enter", alt: true });
    expect(gestures.take()).toBe(false);
  });

  it("isn't had for a page the window went to after the gesture, nor past a few a minute", () => {
    let time = 0;
    const gestures = makeSiteGestures(() => time);
    gestures.pointer();
    gestures.navigated();
    expect(gestures.take()).toBe(false);
    for (let given = 0; given < SITE_GRANTS_PER_MINUTE; given += 1) {
      gestures.pointer();
      expect(gestures.take()).toBe(true);
      time += 1_000;
    }
    gestures.pointer();
    expect(gestures.take()).toBe(false);
    time += 60_000;
    gestures.pointer();
    expect(gestures.take()).toBe(true);
  });

  it("comes only from the server's own top page", () => {
    const origin = "https://hosted.example";
    expect(fromSitePage({ mainFrame: true, url: `${origin}/w/ws_1` }, origin)).toBe(true);
    expect(fromSitePage({ mainFrame: false, url: `${origin}/w/ws_1` }, origin)).toBe(false);
    expect(fromSitePage({ mainFrame: true, url: "https://idp.example/login" }, origin)).toBe(false);
    expect(fromSitePage({ mainFrame: true, url: "not a url" }, origin)).toBe(false);
    expect(fromSitePage({ mainFrame: true, url: undefined }, origin)).toBe(false);
  });

  it("names a thread as Gram does, and keeps the window to web pages", () => {
    expect(siteThreadIdOf({ threadId: "t_1" })).toBe("t_1");
    expect(siteThreadIdOf({ threadId: "../x" })).toBeUndefined();
    expect(siteThreadIdOf("t_1")).toBeUndefined();
    expect(staysIn("https://idp.example/login", "https://hosted.example")).toBe(true);
    expect(staysIn("http://127.0.0.1:4310/w", "http://127.0.0.1:4310")).toBe(true);
    expect(staysIn("file:///etc/passwd", "https://hosted.example")).toBe(false);
    expect(staysIn("vscode://open", "https://hosted.example")).toBe(false);
  });

  it("names the host it shows, and off the server's origin never the page's own words", () => {
    const origin = "https://hosted.example";
    expect(siteTitle(`${origin}/w/ws_1`, origin, "Orchestrator")).toBe(
      "hosted.example: Orchestrator",
    );
    expect(siteTitle("https://idp.example/login", origin, "Sign in to hosted.example")).toBe(
      "idp.example, not hosted.example",
    );
  });
});

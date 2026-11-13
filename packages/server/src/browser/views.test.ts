import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneViewPort } from "./pane-port.ts";
import { createBrowserViews, type ViewEvent } from "./views.ts";

const fakePort = () => {
  const posted: Array<unknown> = [];
  let hear: ((message: unknown) => void) | undefined;
  let stopped: (() => void) | undefined;
  const port: PaneViewPort = {
    post: (message) => void posted.push(message),
    on: (listener) => {
      hear = listener;
    },
    onStopped: (listener) => {
      stopped = listener;
    },
  };
  return { port, posted, say: (message: unknown) => hear?.(message), stop: () => stopped?.() };
};

const PAGE = {
  url: "http://localhost:5173/",
  title: "App",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  driver: "agent",
};

describe("createBrowserViews", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the host while someone watches, and stops asking when nobody does", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port, 1_000);
    const first = views.watch("t", () => {});
    const second = views.watch("t", () => {});
    // The first ask says the server has nothing of the page yet, and so does each one after it
    // until the host has answered: it may not have been running to hear.
    expect(host.posted).toEqual([{ type: "pane.view.watch", threadId: "t", fresh: true }]);
    vi.advanceTimersByTime(1_000);
    expect(host.posted.at(-1)).toEqual({ type: "pane.view.watch", threadId: "t", fresh: true });
    host.say({ type: "pane.view.page", threadId: "t", page: null });
    vi.advanceTimersByTime(1_000);
    expect(host.posted.at(-1)).toEqual({ type: "pane.view.watch", threadId: "t" });
    expect(host.posted).toHaveLength(3);
    first();
    vi.advanceTimersByTime(1_000);
    expect(host.posted).toHaveLength(4);
    second();
    vi.advanceTimersByTime(5_000);
    expect(host.posted).toHaveLength(4);
  });

  it("tells a watcher what the page is now, then each change and frame", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port);
    const seen: Array<ViewEvent> = [];
    views.watch("t", (event) => seen.push(event));
    expect(seen).toEqual([{ type: "page", page: null }]);
    host.say({ type: "pane.view.page", threadId: "t", page: { ...PAGE, extra: "dropped" } });
    host.say({ type: "pane.view.frame", threadId: "t", jpeg: "/9j/", width: 800, height: 600 });
    host.say({ type: "pane.view.frame", threadId: "other", jpeg: "/9j/", width: 1, height: 1 });
    expect(seen.slice(1)).toEqual([
      { type: "page", page: PAGE },
      { type: "frame", jpeg: "/9j/", width: 800, height: 600 },
    ]);
    // Someone who comes later starts from the same page and its latest frame.
    const late: Array<ViewEvent> = [];
    views.watch("t", (event) => late.push(event));
    expect(late).toEqual(seen.slice(1));
  });

  it("says why there is no page, and forgets the frame of one that went", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port);
    const seen: Array<ViewEvent> = [];
    views.watch("t", (event) => seen.push(event));
    host.say({ type: "pane.view.page", threadId: "t", page: PAGE });
    host.say({ type: "pane.view.frame", threadId: "t", jpeg: "/9j/", width: 800, height: 600 });
    host.say({
      type: "pane.view.page",
      threadId: "t",
      page: null,
      status: { kind: "failed", message: "No browser." },
    });
    expect(seen.at(-1)).toEqual({
      type: "page",
      page: null,
      status: { kind: "failed", message: "No browser." },
    });
    const late: Array<ViewEvent> = [];
    views.watch("t", (event) => late.push(event));
    expect(late).toHaveLength(1);
  });

  it("shows no page once the host stops", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port);
    const seen: Array<ViewEvent> = [];
    views.watch("t", (event) => seen.push(event));
    host.say({ type: "pane.view.page", threadId: "t", page: PAGE });
    host.stop();
    expect(seen.at(-1)).toEqual({ type: "page", page: null });
  });

  it("asks afresh when someone comes back after the last watcher left", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port, 1_000);
    const end = views.watch("t", () => {});
    host.say({ type: "pane.view.page", threadId: "t", page: PAGE });
    end();
    const seen: Array<ViewEvent> = [];
    views.watch("t", (event) => seen.push(event));
    // The host may still be sending the page from the watch that just ended, and says nothing
    // of what hasn't changed: it is asked for all of it again.
    expect(host.posted.at(-1)).toEqual({ type: "pane.view.watch", threadId: "t", fresh: true });
    host.say({ type: "pane.view.page", threadId: "t", page: PAGE });
    expect(seen.at(-1)).toEqual({ type: "page", page: PAGE });
  });

  it("cuts a long title and refuses an address past any real one", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port);
    const seen: Array<ViewEvent> = [];
    views.watch("t", (event) => seen.push(event));
    host.say({
      type: "pane.view.page",
      threadId: "t",
      page: { ...PAGE, title: "t".repeat(5_000) },
    });
    const last = seen.at(-1);
    expect(last?.type === "page" && last.page?.title.length).toBe(300);
    host.say({ type: "pane.view.page", threadId: "t", page: { ...PAGE, url: "u".repeat(50_000) } });
    expect(seen.at(-1)).toEqual({ type: "page", page: null });
  });

  it("carries input and the strip's buttons only for a thread someone watches", () => {
    const host = fakePort();
    const views = createBrowserViews(host.port);
    const inputs = [{ type: "wheel", x: 1, y: 1, deltaX: 0, deltaY: 40, modifiers: 0 }] as const;
    views.input("t", inputs);
    views.control("t", "reload");
    expect(host.posted).toEqual([]);
    const end = views.watch("t", () => {});
    views.input("t", inputs);
    views.control("t", "handBack");
    expect(host.posted.slice(1)).toEqual([
      { type: "pane.view.input", threadId: "t", inputs },
      { type: "pane.view.control", threadId: "t", op: "handBack" },
    ]);
    end();
  });
});

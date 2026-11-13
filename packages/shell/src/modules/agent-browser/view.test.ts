import type { ViewHostMessage, ViewInput } from "@gram/contracts/link-trust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HeadlessFrame, HeadlessPage } from "./headless.ts";
import type { PaneContents } from "./pane.ts";
import { createViews } from "./view.ts";

/** A thread's page and pane, as much of them as watching touches. */
const fakePage = () => {
  let driver: "agent" | "user" = "agent";
  let frame: ((frame: HeadlessFrame) => void) | undefined;
  const inputs: Array<ViewInput> = [];
  const did: Array<string> = [];
  const contents = {
    getURL: () => "http://localhost:5173/",
    getTitle: () => "App",
    isLoading: () => false,
    isDestroyed: () => false,
    navigationHistory: { canGoBack: () => true, goBack: () => did.push("back") },
  } as unknown as PaneContents;
  const page: HeadlessPage = {
    screencast: (listener) => {
      frame = listener;
      return () => {
        frame = undefined;
      };
    },
    input: async (input) => void inputs.push(input),
    reload: () => void did.push("reload"),
    canGoBack: () => true,
    goForward: () => void did.push("forward"),
    canGoForward: () => false,
    letGo: () => void did.push("letGo"),
  };
  const panes = {
    driverOf: () => driver,
    actionOf: () => undefined,
    recordingOf: () => false,
    takeOver: () => {
      driver = "user";
    },
    handBack: () => {
      driver = "agent";
    },
  };
  return {
    contents,
    page,
    panes,
    inputs,
    did,
    driver: () => driver,
    paint: (jpeg: string) => frame?.({ jpeg, width: 800, height: 600 }),
    watched: () => frame !== undefined,
  };
};

const press: ViewInput = {
  type: "pointer",
  action: "down",
  x: 5,
  y: 5,
  button: "left",
  buttons: 1,
  clickCount: 1,
  modifiers: 0,
};
const move: ViewInput = { ...press, action: "move", button: "none", buttons: 0, clickCount: 0 };

/** The views over one fake page, with short timers. */
const start = (has = true) => {
  const fake = fakePage();
  const sent: Array<ViewHostMessage> = [];
  let present = has;
  const views = createViews({
    panes: fake.panes,
    pageOf: async () => (present ? fake.contents : undefined),
    watch: () => fake.page,
    statusOf: () => undefined,
    send: (message) => sent.push(message),
    idleMs: 1_000,
    leaseMs: 3_000,
    pollMs: 100,
  });
  const watch = () => views.message({ type: "pane.view.watch", threadId: "t" });
  const pages = () => sent.flatMap((each) => (each.type === "pane.view.page" ? [each.page] : []));
  return {
    fake,
    sent,
    views,
    watch,
    pages,
    appear: () => (present = true),
    vanish: () => (present = false),
  };
};

describe("createViews", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a watched thread's page once, then only what changed, and its frames", async () => {
    const { fake, sent, watch, pages } = start();
    expect(watch()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(pages()).toEqual([
      {
        url: "http://localhost:5173/",
        title: "App",
        loading: false,
        canGoBack: true,
        canGoForward: false,
        driver: "agent",
      },
    ]);
    fake.paint("/9j/a");
    expect(sent.at(-1)).toEqual({
      type: "pane.view.frame",
      threadId: "t",
      jpeg: "/9j/a",
      width: 800,
      height: 600,
    });
  });

  it("shows no page until the thread has one, and never asks for one to be made", async () => {
    const { fake, watch, pages, appear } = start(false);
    watch();
    await vi.advanceTimersByTimeAsync(300);
    expect(pages()).toEqual([null]);
    expect(fake.watched()).toBe(false);
    appear();
    await vi.advanceTimersByTimeAsync(300);
    expect(pages().at(-1)).toMatchObject({ title: "App" });
    expect(fake.watched()).toBe(true);
  });

  it("gives the page to a person who presses, and back once they have sent nothing for a while", async () => {
    const { fake, views, watch, pages } = start();
    watch();
    await vi.advanceTimersByTimeAsync(200);
    // A pointer passing over the agent's page is no one's input.
    views.message({ type: "pane.view.input", threadId: "t", inputs: [move] });
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.driver()).toBe("agent");
    expect(fake.inputs).toEqual([]);

    views.message({ type: "pane.view.input", threadId: "t", inputs: [press, move] });
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.driver()).toBe("user");
    expect(fake.inputs).toEqual([press, move]);
    expect(pages().at(-1)).toMatchObject({ driver: "user" });

    // More input keeps it theirs.
    await vi.advanceTimersByTimeAsync(800);
    watch();
    views.message({ type: "pane.view.input", threadId: "t", inputs: [move] });
    await vi.advanceTimersByTimeAsync(800);
    expect(fake.driver()).toBe("user");
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.driver()).toBe("agent");
    expect(pages().at(-1)).toMatchObject({ driver: "agent" });
  });

  it("takes the strip's buttons as the person's, and hands back at once when asked", async () => {
    const { fake, views, watch } = start();
    watch();
    await vi.advanceTimersByTimeAsync(200);
    views.message({ type: "pane.view.control", threadId: "t", op: "reload" });
    views.message({ type: "pane.view.control", threadId: "t", op: "back" });
    views.message({ type: "pane.view.control", threadId: "t", op: "forward" });
    expect(fake.did).toEqual(["reload", "back", "forward"]);
    expect(fake.driver()).toBe("user");
    views.message({ type: "pane.view.control", threadId: "t", op: "handBack" });
    expect(fake.driver()).toBe("agent");
    // Nothing of the person's stays held down in a page that is the agent's again.
    expect(fake.did.at(-1)).toBe("letGo");
  });

  it("puts one batch into the page after another, however slow the page is", async () => {
    const { fake, views, watch } = start();
    watch();
    await vi.advanceTimersByTimeAsync(200);
    const slow = fake.page.input;
    fake.page.input = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, input.type === "pointer" ? 50 : 0));
      await slow(input);
    };
    const key: ViewInput = {
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      modifiers: 0,
    };
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press, move] });
    views.message({ type: "pane.view.input", threadId: "t", inputs: [key] });
    await vi.advanceTimersByTimeAsync(300);
    expect(fake.inputs).toEqual([press, move, key]);
  });

  it("drives nothing that isn't watched", async () => {
    const { fake, views } = start();
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press] });
    views.message({ type: "pane.view.control", threadId: "t", op: "reload" });
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.driver()).toBe("agent");
    expect(fake.inputs).toEqual([]);
    expect(fake.did).toEqual([]);
  });

  it("stops the frames, and gives the page back, when the server stops asking", async () => {
    const { fake, views, watch } = start();
    watch();
    await vi.advanceTimersByTimeAsync(200);
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press] });
    await vi.advanceTimersByTimeAsync(10);
    expect(fake.driver()).toBe("user");
    // The idle timer is far off here; the lease ends first.
    watch();
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press] });
    await vi.advanceTimersByTimeAsync(900);
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press] });
    await vi.advanceTimersByTimeAsync(900);
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press] });
    await vi.advanceTimersByTimeAsync(900);
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press] });
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.watched()).toBe(false);
    expect(fake.driver()).toBe("agent");
  });

  it("says the page and sends a frame again to a server that has nothing of it yet", async () => {
    const { fake, sent, watch, views, pages } = start();
    watch();
    await vi.advanceTimersByTimeAsync(200);
    expect(pages()).toHaveLength(1);
    // Asked again as ever: nothing changed, so nothing is said.
    watch();
    await vi.advanceTimersByTimeAsync(200);
    expect(pages()).toHaveLength(1);
    views.message({ type: "pane.view.watch", threadId: "t", fresh: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(pages()).toHaveLength(2);
    // The frames were started again, which is what makes a still page send one.
    fake.paint("/9j/b");
    expect(sent.at(-1)).toMatchObject({ type: "pane.view.frame", jpeg: "/9j/b" });
  });

  it("drops the rest of a batch when its page goes while an input is on its way in", async () => {
    const { fake, views, watch, vanish } = start();
    watch();
    await vi.advanceTimersByTimeAsync(200);
    const plain = fake.page.input;
    fake.page.input = async (input) => {
      await plain(input);
      vanish();
      // The watch finds the page gone before the next input.
      await vi.advanceTimersByTimeAsync(200);
    };
    views.message({ type: "pane.view.input", threadId: "t", inputs: [press, press, press] });
    await vi.advanceTimersByTimeAsync(600);
    expect(fake.inputs).toEqual([press]);
  });

  it("says a message about a view is its own, even one it refuses", () => {
    const { views } = start();
    expect(views.message({ type: "pane.view.control", threadId: "t", op: "navigate" })).toBe(true);
    expect(views.message({ type: "pane.request", id: "a" })).toBe(false);
    expect(views.message(null)).toBe(false);
  });
});

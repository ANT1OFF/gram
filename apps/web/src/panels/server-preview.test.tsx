// @vitest-environment happy-dom
import type { BrowserViewInput, ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { BrowserViewFeedEvent } from "@/api/browser-view/types";
import { createChannel } from "@/api/channel";
import { ApiProvider } from "@/api/context";
import type { Api } from "@/api/types";
import { TooltipProvider } from "@/components/ui/tooltip";

import { keyInput, ServerPreview, typedBy, useServerPage } from "./server-preview";

const THREAD = "thread-1" as ThreadId;

const PAGE = {
  url: "http://localhost:5173/invoices",
  title: "Invoices",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  driver: "agent" as const,
  action: { summary: "Opens the Filters menu", at: 1_763_044_320_000 },
};

const FRAME = { type: "frame" as const, jpeg: "/9j/AA==", width: 800, height: 600 };

/** A server whose feed each test pushes events into, recording what the tab sends back. */
const fakeServer = (fails = false) => {
  const feed = createChannel<BrowserViewFeedEvent>();
  const inputs: Array<BrowserViewInput> = [];
  const controls: Array<string> = [];
  const api = {
    browserViewFeed: fails
      ? // eslint-disable-next-line require-yield
        async function* () {
          throw Object.assign(new Error("none"), { _tag: "InvalidState" });
        }
      : () => feed,
    browserViewInput: async (_thread: ThreadId, batch: ReadonlyArray<BrowserViewInput>) => {
      inputs.push(...batch);
    },
    browserViewControl: async (_thread: ThreadId, op: string) => {
      controls.push(op);
    },
  } as unknown as Api;
  return { api, feed, inputs, controls };
};

function Tab() {
  const view = useServerPage(THREAD, true);
  return view === undefined ? (
    <p data-testid="no-server-page" />
  ) : (
    <ServerPreview threadId={THREAD} view={view} />
  );
}

const mount = (server: ReturnType<typeof fakeServer>) =>
  render(
    <ApiProvider api={server.api}>
      <TooltipProvider>
        <Tab />
      </TooltipProvider>
    </ApiProvider>,
  );

const say = async (server: ReturnType<typeof fakeServer>, ...events: BrowserViewFeedEvent[]) => {
  await act(async () => {
    for (const event of events) server.feed.push(event);
    await Promise.resolve();
  });
};

/** The drawn page at 400 by 300 in the window: half the page's own size. */
const place = () => {
  const frame = screen.getByTestId("server-preview-frame");
  frame.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      right: 500,
      bottom: 350,
      x: 100,
      y: 50,
    }) as DOMRect;
  return screen.getByTestId("server-preview-stage");
};

afterEach(cleanup);

describe("ServerPreview", () => {
  it("is absent where the server runs no browser of its own", async () => {
    mount(fakeServer(true));
    await waitFor(() => expect(screen.getByTestId("no-server-page")).toBeTruthy());
  });

  it("says there is no page yet, that the browser is starting, and why it couldn't", async () => {
    const server = fakeServer();
    mount(server);
    await say(server, { type: "page", page: null });
    expect(screen.getByTestId("server-preview").dataset["state"]).toBe("empty");
    expect(screen.getByTestId("server-preview-empty").textContent).toContain("No page yet");
    await say(server, { type: "page", page: null, status: { kind: "starting" } });
    expect(screen.getByTestId("server-preview").dataset["state"]).toBe("starting");
    await say(server, {
      type: "page",
      page: null,
      status: { kind: "failed", message: "Its log says why." },
    });
    expect(screen.getByTestId("server-preview-failed").textContent).toContain("Its log says why.");
  });

  it("draws the agent's page with what the agent is doing, and how to take over", async () => {
    const server = fakeServer();
    mount(server);
    await say(server, { type: "page", page: PAGE }, FRAME);
    expect(screen.getByTestId("server-preview").dataset["state"]).toBe("agent");
    const frame = screen.getByTestId("server-preview-frame") as HTMLImageElement;
    expect(frame.src).toBe("data:image/jpeg;base64,/9j/AA==");
    expect((screen.getByTestId("preview-address") as HTMLInputElement).value).toBe(PAGE.url);
    expect(screen.getByTestId("preview-action").textContent).toBe("Opens the Filters menu");
    expect(screen.getByTestId("server-preview-hint").textContent).toContain("take over");
    expect(screen.getByTestId("preview-driver").dataset["driver"]).toBe("agent");
  });

  it("sends a press where it fell on the page, and no pointer passing over the agent's page", async () => {
    const server = fakeServer();
    mount(server);
    await say(server, { type: "page", page: PAGE }, FRAME);
    const stage = place();
    fireEvent.mouseMove(stage, { clientX: 300, clientY: 200 });
    fireEvent.mouseDown(stage, { clientX: 300, clientY: 200, button: 0, buttons: 1, detail: 1 });
    fireEvent.mouseUp(stage, { clientX: 300, clientY: 200, button: 0, buttons: 0, detail: 1 });
    // Outside the drawn page: nothing.
    fireEvent.mouseDown(stage, { clientX: 20, clientY: 20, button: 0, buttons: 1, detail: 1 });
    await waitFor(() => expect(server.inputs).toHaveLength(2));
    expect(server.inputs).toEqual([
      {
        type: "pointer",
        action: "down",
        x: 400,
        y: 300,
        button: "left",
        buttons: 1,
        clickCount: 1,
        modifiers: 0,
      },
      {
        type: "pointer",
        action: "up",
        x: 400,
        y: 300,
        button: "left",
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      },
    ]);
  });

  it("lets a held button go wherever the pointer is by then, at the page's nearest point", async () => {
    const server = fakeServer();
    mount(server);
    await say(server, { type: "page", page: { ...PAGE, driver: "user" } }, FRAME);
    const stage = place();
    fireEvent.mouseDown(stage, { clientX: 300, clientY: 200, button: 0, buttons: 1, detail: 1 });
    // Released outside the tab's page altogether.
    fireEvent.mouseUp(document.body, {
      clientX: 900,
      clientY: 10,
      button: 0,
      buttons: 0,
      detail: 1,
    });
    // A release with nothing held is no one's.
    fireEvent.mouseUp(document.body, { clientX: 300, clientY: 200, button: 0, buttons: 0 });
    await waitFor(() => expect(server.inputs).toHaveLength(2));
    expect(server.inputs[1]).toMatchObject({ type: "pointer", action: "up", x: 800, y: 0 });
  });

  it("says the page is yours, sends your pointer and keys, and hands back", async () => {
    const server = fakeServer();
    mount(server);
    await say(server, { type: "page", page: { ...PAGE, driver: "user" } }, FRAME);
    expect(screen.getByTestId("server-preview").dataset["state"]).toBe("yours");
    expect(screen.getByTestId("server-preview-yours").textContent).toContain(
      "returns to the agent after 20 s",
    );
    expect(screen.queryByTestId("server-preview-hint")).toBeNull();
    const stage = place();
    fireEvent.mouseMove(stage, { clientX: 100, clientY: 50 });
    fireEvent.keyDown(stage, { key: "a", code: "KeyA", keyCode: 65 });
    fireEvent.keyUp(stage, { key: "a", code: "KeyA", keyCode: 65 });
    // Command stays the app's, and so does a shortcut the page may not get.
    fireEvent.keyDown(stage, { key: "k", code: "KeyK", keyCode: 75, metaKey: true });
    expect(fireEvent.keyDown(stage, { key: "n", code: "KeyN", keyCode: 78, ctrlKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(stage, { key: "F12", code: "F12", keyCode: 123 })).toBe(true);
    // Shift+Escape is the way out of the page for the keyboard.
    stage.focus();
    fireEvent.keyDown(stage, { key: "Escape", code: "Escape", keyCode: 27, shiftKey: true });
    expect(document.activeElement).toBe(screen.getByTestId("preview-address"));
    await waitFor(() => expect(server.inputs).toHaveLength(3));
    expect(server.inputs.map((input) => input.type)).toEqual(["pointer", "key", "key"]);
    expect(server.inputs[1]).toEqual({
      type: "key",
      action: "down",
      key: "a",
      code: "KeyA",
      keyCode: 65,
      modifiers: 0,
      text: "a",
    });
    fireEvent.click(screen.getByLabelText("You have control. Hand the page back to the agent"));
    fireEvent.click(screen.getByLabelText("Back"));
    await waitFor(() => expect(server.controls).toEqual(["handBack", "back"]));
  });

  it("keeps the last frame, dimmed, while the connection is reopened", async () => {
    const server = fakeServer();
    mount(server);
    await say(server, { type: "page", page: PAGE }, FRAME);
    await say(server, { type: "dropped" });
    expect(screen.getByTestId("server-preview").dataset["state"]).toBe("reconnecting");
    expect(screen.getByTestId("server-preview-frame").className).toContain("opacity-45");
    expect(screen.getByTestId("server-preview-reconnecting")).toBeTruthy();
    await say(server, { type: "page", page: PAGE });
    expect(screen.getByTestId("server-preview").dataset["state"]).toBe("agent");
  });
});

/** A key event, as much of one as `keyInput` reads. */
const key = (init: Partial<KeyboardEvent>) =>
  ({
    key: "a",
    code: "KeyA",
    keyCode: 65,
    repeat: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

describe("keyInput", () => {
  it("types what a key types, and nothing for a shortcut or a key that types nothing", () => {
    expect(typedBy(key({}))).toBe("a");
    expect(typedBy(key({ key: "Enter" }))).toBe("\r");
    expect(typedBy(key({ key: "ArrowLeft" }))).toBeUndefined();
    expect(typedBy(key({ ctrlKey: true }))).toBeUndefined();
    // Control with Alt is AltGr.
    expect(typedBy(key({ ctrlKey: true, altKey: true, key: "@" }))).toBe("@");
    expect(typedBy(key({ key: "😀" }))).toBe("😀");
  });

  it("carries the modifiers as bits, and no text on the way up", () => {
    expect(keyInput(key({ shiftKey: true, key: "A" }), "down")).toMatchObject({
      text: "A",
      modifiers: 8,
    });
    expect(keyInput(key({ ctrlKey: true, altKey: true }), "down").modifiers).toBe(3);
    expect(keyInput(key({}), "up")).not.toHaveProperty("text");
    expect(keyInput(key({ repeat: true }), "down")).toMatchObject({ repeat: true });
  });
});

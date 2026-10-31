// @vitest-environment happy-dom
import { DEFAULT_SETTINGS, type ThreadId } from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionControl } from "@/api/connection";
import { createMockApi } from "@/api/mock";
import { MOCK_SESSION_EXPIRED_KEY } from "@/api/mock-overrides";
import { renderWithApi } from "@/panels/test-utils";
import { useDiffCommentsStore, type DiffComment } from "@/stores/diff-comments";
import { useServerSettings } from "@/settings-sync/store";
import { useDraftStore } from "@/stores/drafts";
import { useSuggestionsStore } from "@/stores/suggestions";
import { useThreadsStore } from "@/stores/threads";

import { Composer } from "./composer";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));

const THREAD = "t-steer" as ThreadId;

const setup = ({ steers = true }: { steers?: boolean } = {}) => {
  // Invented provider/CLI discovery and an explicitly accepted synthetic session, never host auth.
  sessionStorage.setItem(MOCK_SESSION_EXPIRED_KEY, "0");
  useThreadsStore.setState({
    byId: {
      [THREAD]: {
        status: "running",
        capabilities: { steer: steers },
        thread: { id: THREAD, checkout: { path: "/work/repo" } },
      },
    } as never,
  });
  const api = createMockApi({ speed: 0, autoplay: false, agents: ["claude"], persist: false });
  const steer = vi.spyOn(api, "steer").mockResolvedValue(undefined);
  const view = renderWithApi(<Composer threadId={THREAD} focused />, api);
  const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
  return { api, steer, textarea, unmount: view.unmount };
};

const steerNow = () =>
  fireEvent.click(screen.getByRole("button", { name: "Queue" }), { metaKey: true });

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
  useDraftStore.setState({ text: {} });
  useDiffCommentsStore.setState({ byThread: {} });
});

// Observe the scheduled callback actually running, rather than React ignoring an update to a
// removed component. Unrelated animation/query timers don't count as hint expiry.
const observeExpiry = () => {
  vi.useFakeTimers();
  const schedule = globalThis.setTimeout;
  const expired = vi.fn();
  const timers = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      if (delay !== 2500) return schedule(callback, delay, ...args);
      return schedule(() => {
        expired();
        callback(...args);
      }, delay);
    });
  return { expired, timers };
};

describe("Composer hint lifetime", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a replacement hint for its full duration, then expires it once", async () => {
    const { expired } = observeExpiry();
    const { steer, textarea } = setup();
    fireEvent.change(textarea, { target: { value: "first direction" } });
    await act(async () => steerNow());
    expect(screen.getByText("Steering…")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("Steering…")).toBeTruthy();

    steer.mockRejectedValueOnce(new Error("turn finished"));
    fireEvent.change(textarea, { target: { value: "second direction" } });
    await act(async () => steerNow());
    expect(screen.queryByText("Steering…")).toBeNull();
    expect(screen.getByText("Couldn't steer: turn finished")).toBeTruthy();
    expect(textarea.value).toBe("second direction");
    act(() => vi.advanceTimersByTime(500));
    expect(expired).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't steer: turn finished")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1999));
    expect(screen.getByText("Couldn't steer: turn finished")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Couldn't steer: turn finished")).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("cancels pending hint expiry when the composer unmounts", async () => {
    const { expired, timers } = observeExpiry();
    const { textarea, unmount } = setup();
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    await act(async () => steerNow());
    expect(screen.getByText("Steering…")).toBeTruthy();
    expect(timers.mock.calls.filter(([, delay]) => delay === 2500)).toHaveLength(1);
    unmount();
    act(() => vi.advanceTimersByTime(2500));
    expect(expired).not.toHaveBeenCalled();
  });

  it("creates no hint timer when an in-flight steer finishes after unmount", async () => {
    const { expired, timers } = observeExpiry();
    const { steer, textarea, unmount } = setup();
    const inFlight = Promise.withResolvers<void>();
    steer.mockReturnValueOnce(inFlight.promise);
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    await act(async () => steerNow());
    expect(steer).toHaveBeenCalledWith(THREAD, { text: "use vitest" });
    expect(screen.queryByText("Steering…")).toBeNull();
    unmount();
    await act(async () => inFlight.resolve());
    expect(timers.mock.calls.filter(([, delay]) => delay === 2500)).toHaveLength(0);
    act(() => vi.advanceTimersByTime(2500));
    expect(expired).not.toHaveBeenCalled();
  });
});

describe("Composer steer", () => {
  it("sends the draft into the running turn and clears the composer", async () => {
    const { steer, textarea } = setup();
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    steerNow();
    await waitFor(() => expect(steer).toHaveBeenCalledWith(THREAD, { text: "use vitest" }));
    expect(textarea.value).toBe("");
    expect(screen.getByText("Steering…")).toBeTruthy();
  });

  it("gives the draft back when the steer is rejected", async () => {
    const { steer, textarea } = setup();
    steer.mockRejectedValueOnce(new Error("nothing to steer"));
    fireEvent.change(textarea, { target: { value: "too late" } });
    steerNow();
    await waitFor(() => expect(textarea.value).toBe("too late"));
    expect(screen.getByText(/Couldn't steer/)).toBeTruthy();
  });

  it("waits for a dropped connection with the draft still in the box, saying so, then steers", async () => {
    const { api, steer, textarea } = setup();
    // The mock's monitor is the full control the feeds report through.
    const connection = api.connection as ConnectionControl;
    const feed = Symbol("feed");
    connection.opened(feed);
    connection.failed(feed, 1, Date.now() + 60_000);
    fireEvent.change(textarea, { target: { value: "after the wake" } });
    steerNow();
    await waitFor(() => expect(screen.getByText(/Waiting for the connection/)).toBeTruthy());
    // A second press while it waits queues nothing, and the notice stays past a flash's 2.5 s.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    steerNow();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    vi.useRealTimers();
    expect(screen.getByText(/Waiting for the connection/)).toBeTruthy();
    // Kept where a reload of the window keeps it.
    expect(textarea.value).toBe("after the wake");
    expect(useDraftStore.getState().text[THREAD]).toBe("after the wake");
    expect(steer).not.toHaveBeenCalled();
    connection.opened(feed);
    await waitFor(() => expect(steer).toHaveBeenCalledWith(THREAD, { text: "after the wake" }));
    expect(textarea.value).toBe("");
    expect(screen.queryByText(/Waiting for the connection/)).toBeNull();
  });

  it("sends nothing by itself once the draft changed while it waited, nor after the composer went", async () => {
    const { api, steer, textarea } = setup();
    const connection = api.connection as ConnectionControl;
    const feed = Symbol("feed");
    connection.opened(feed);
    connection.failed(feed, 1, Date.now() + 60_000);
    fireEvent.change(textarea, { target: { value: "first thought" } });
    steerNow();
    await waitFor(() => expect(screen.getByText(/Waiting for the connection/)).toBeTruthy());
    fireEvent.change(textarea, { target: { value: "second thought" } });
    connection.opened(feed);
    await waitFor(() => expect(screen.getByText(/Connected again/)).toBeTruthy());
    expect(steer).not.toHaveBeenCalled();
    expect(textarea.value).toBe("second thought");

    // Pressed, then the thread left and opened again, pressed again: one steer, the new mount's.
    connection.failed(feed, 1, Date.now() + 60_000);
    steerNow();
    await waitFor(() => expect(screen.getByText(/Waiting for the connection/)).toBeTruthy());
    cleanup();
    renderWithApi(<Composer threadId={THREAD} focused />, api);
    // The ended wait lets go of the thread a tick later, long before a person presses again.
    await new Promise((resolve) => setTimeout(resolve, 0));
    steerNow();
    connection.opened(feed);
    await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer).toHaveBeenCalledWith(THREAD, { text: "second thought" });
  });

  it("sends nothing by itself when a file pasted while it waited is still uploading", async () => {
    const { api, steer, textarea } = setup();
    vi.spyOn(api, "uploadAttachment").mockReturnValue(new Promise(() => {}));
    const connection = api.connection as ConnectionControl;
    const feed = Symbol("feed");
    connection.opened(feed);
    connection.failed(feed, 1, Date.now() + 60_000);
    fireEvent.change(textarea, { target: { value: "with a screenshot" } });
    steerNow();
    await waitFor(() => expect(screen.getByText(/Waiting for the connection/)).toBeTruthy());
    const file = new File(["x"], "shot.txt", { type: "text/plain" });
    fireEvent.paste(textarea, { clipboardData: { files: [file], getData: () => "" } });
    await waitFor(() => expect(screen.getByText("shot.txt")).toBeTruthy());
    connection.opened(feed);
    await waitFor(() => expect(screen.getByText(/Connected again/)).toBeTruthy());
    expect(steer).not.toHaveBeenCalled();
    expect(textarea.value).toBe("with a screenshot");
    expect(screen.getByText("shot.txt")).toBeTruthy();
  });

  it("is one button: Stop while empty, Queue with a draft, each with its name", () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByTestId("running-edge")).toBeTruthy();
  });

  it("stops the turn from the empty button, but not on a double click's second click", () => {
    const { api, textarea } = setup();
    const interrupt = vi.spyOn(api, "interrupt").mockResolvedValue(undefined);
    fireEvent.change(textarea, { target: { value: "" } });
    const stop = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(stop, { detail: 2 });
    expect(interrupt).not.toHaveBeenCalled();
    fireEvent.click(stop, { detail: 1 });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("turns to Steer while the modifier is down, and back", () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(screen.getByRole("button", { name: "Steer now" })).toBeTruthy();
    fireEvent.keyUp(window, { key: "Meta" });
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
  });

  it("queues rather than steers for an agent that takes no input mid-turn", async () => {
    const { textarea, steer, api } = setup({ steers: false });
    const send = vi.spyOn(api, "send").mockResolvedValue({ queued: true } as never);
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(screen.queryByRole("button", { name: "Steer now" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }), { metaKey: true });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(steer).not.toHaveBeenCalled();
  });

  it("keeps Stop in the right-click menu while a draft has the button", async () => {
    const { api, textarea } = setup();
    const interrupt = vi.spyOn(api, "interrupt").mockResolvedValue(undefined);
    fireEvent.change(textarea, { target: { value: "use vitest" } });
    fireEvent.contextMenu(screen.getByTestId("send-menu-trigger"));
    const steer = await screen.findByRole("menuitem", { name: /^Steer now/ });
    expect(steer.textContent).toMatch(/(⌘|Ctrl)-click$/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Stop" }));
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("use vitest");
  });
});

describe("Composer diff comments", () => {
  const comment: DiffComment = {
    id: "c1",
    path: "src/retry.ts",
    side: "new",
    start: 13,
    end: 14,
    snippet: "+  const clock = useFakeTimers();\n   const op = flaky(2);",
    note: "Use the shared fake clock.",
  };

  it("shows a chip per comment and sends them ahead of the text", async () => {
    useDiffCommentsStore.getState().add(THREAD, comment);
    const { steer, textarea } = setup();
    expect(screen.getByTestId("diff-comment-chip").textContent).toContain("src/retry.ts:13-14");
    fireEvent.change(textarea, { target: { value: "then rerun" } });
    steerNow();
    await waitFor(() => expect(steer).toHaveBeenCalled());
    expect(steer.mock.calls[0]![1].text).toBe(
      [
        "A review comment on the diff:",
        "src/retry.ts:13-14\n```diff\n+  const clock = useFakeTimers();\n   const op = flaky(2);\n```\nUse the shared fake clock.",
        "then rerun",
      ].join("\n\n"),
    );
    expect(screen.queryByTestId("diff-comment-chip")).toBeNull();
    expect(useDiffCommentsStore.getState().byThread[THREAD]).toEqual([]);
  });

  it("sends comments alone, and gives them back apart from the text when rejected", async () => {
    useDiffCommentsStore.getState().add(THREAD, comment);
    const { steer, textarea } = setup();
    steer.mockRejectedValueOnce(new Error("nothing to steer"));
    // Comments alone are enough to send.
    steerNow();
    await waitFor(() => expect(screen.getByText(/Couldn't steer/)).toBeTruthy());
    expect(textarea.value).toBe("");
    expect(useDiffCommentsStore.getState().byThread[THREAD]).toEqual([comment]);
  });

  it("gives the text and comments back when a send is rejected", async () => {
    useDiffCommentsStore.getState().add(THREAD, comment);
    const { api, textarea } = setup();
    const send = vi.spyOn(api, "send").mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(textarea, { target: { value: "then rerun" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Send|Queue)/ }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    await waitFor(() => expect(textarea.value).toBe("then rerun"));
    expect(useDiffCommentsStore.getState().byThread[THREAD]).toEqual([comment]);
  });

  it("keeps what was typed while a rejected send was in flight", async () => {
    const { api, textarea } = setup();
    const inFlight = Promise.withResolvers<never>();
    vi.spyOn(api, "send").mockReturnValueOnce(inFlight.promise);
    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Send|Queue)/ }));
    await waitFor(() => expect(textarea.value).toBe(""));
    fireEvent.change(textarea, { target: { value: "second" } });
    inFlight.reject(new Error("offline"));
    await waitFor(() => expect(textarea.value).toBe("first\n\nsecond"));
  });

  it("gives a slash command Gram failed at back the same way", async () => {
    const { api, textarea } = setup();
    const inFlight = Promise.withResolvers<never>();
    const rename = vi.spyOn(api, "rename").mockReturnValueOnce(inFlight.promise);
    fireEvent.change(textarea, { target: { value: "/rename Retry without sleeps" } });
    fireEvent.click(screen.getByRole("button", { name: /^(Send|Queue)/ }));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(rename).toHaveBeenCalledWith(THREAD, "Retry without sleeps");
    fireEvent.change(textarea, { target: { value: "second" } });
    inFlight.reject(new Error("offline"));
    await waitFor(() => expect(textarea.value).toBe("/rename Retry without sleeps\n\nsecond"));
  });

  it("drops a comment from its chip", () => {
    useDiffCommentsStore.getState().add(THREAD, comment);
    setup();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove the comment on src/retry.ts:13-14" }),
    );
    expect(screen.queryByTestId("diff-comment-chip")).toBeNull();
  });
});

describe("Composer suggestions on open", () => {
  it("asks once for an idle thread's suggestions, and again after a resync or a plan edit drops them", async () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    useThreadsStore.setState({
      byId: {
        [THREAD]: {
          status: "idle",
          thread: { id: THREAD, checkout: { path: "/work/repo" }, lastActivityAt: 1 },
        },
      } as never,
    });
    const api = createMockApi({ speed: 0, autoplay: false });
    const ask = vi.spyOn(api, "threadSuggestions").mockResolvedValue({
      threadId: THREAD,
      turnId: "turn-1" as never,
      replies: ["Push it"],
    });
    renderWithApi(<Composer threadId={THREAD} focused />, api);
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(useSuggestionsStore.getState().byThread[THREAD]).toBeDefined());
    useSuggestionsStore.getState().reset();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useSuggestionsStore.getState().byThread[THREAD]).toBeDefined());
    // Taken back for an edited plan: asked for again, once each time.
    const takeBack = () =>
      useSuggestionsStore
        .getState()
        .offer({ threadId: THREAD, turnId: "turn-1" as never, replies: [], stale: true });
    takeBack();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(useSuggestionsStore.getState().byThread[THREAD]?.stale).toBe(false));
    takeBack();
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(4));
    useSuggestionsStore.setState({ byThread: {}, generation: 0 });
  });
});

describe("Composer suggestion ghost", () => {
  const GHOSTED = "t-ghost" as ThreadId;
  const REPLY = "Check whether CI is passing.";
  const setupGhost = () => {
    useServerSettings.setState({ settings: DEFAULT_SETTINGS });
    useThreadsStore.setState({
      byId: {
        [GHOSTED]: {
          status: "idle",
          thread: { id: GHOSTED, checkout: { path: "/work/repo" }, lastActivityAt: 1 },
        },
      } as never,
    });
    const api = createMockApi({ speed: 0, autoplay: false });
    vi.spyOn(api, "threadSuggestions").mockResolvedValue({
      threadId: GHOSTED,
      turnId: "turn-1" as never,
      replies: [REPLY],
    });
    // A turn still open on the server: the message waits in its queue and no new turn starts.
    const send = vi.spyOn(api, "send").mockResolvedValue({ queued: true });
    renderWithApi(<Composer threadId={GHOSTED} focused />, api);
    const textarea = screen.getByRole("combobox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    return { send, textarea };
  };

  afterEach(() => {
    useSuggestionsStore.setState({ byThread: {}, generation: 0 });
  });

  it("is replaced by typing, and Enter sends only what was typed", async () => {
    const { send, textarea } = setupGhost();
    await waitFor(() => expect(screen.getByTestId("composer-ghost").textContent).toContain(REPLY));
    fireEvent.change(textarea, { target: { value: "merge it" } });
    expect(screen.queryByTestId("composer-ghost")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith(GHOSTED, { text: "merge it" }));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is sent once: what was sent doesn't come back into the box while the message waits", async () => {
    const { send, textarea } = setupGhost();
    await waitFor(() => expect(screen.getByTestId("composer-ghost")).toBeTruthy());
    fireEvent.keyDown(textarea, { key: "ArrowRight" });
    expect(textarea.value).toBe(REPLY);
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith(GHOSTED, { text: REPLY }));
    expect(textarea.value).toBe("");
    expect(screen.queryByTestId("composer-ghost")).toBeNull();
    // → and Enter again, as on a box that looks as it did before the send: nothing goes.
    fireEvent.keyDown(textarea, { key: "ArrowRight" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

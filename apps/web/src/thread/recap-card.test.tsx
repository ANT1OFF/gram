// @vitest-environment happy-dom
import type {
  GramUIMessage,
  HelperEventPayload,
  RecapView,
  ThreadId,
  ThreadSummary,
  TurnId,
  WrapUpData,
} from "@gram/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOCK_DEPS_GIT, MOCK_DEPS_PLAN, MOCK_DEPS_RECAP } from "@/api/mock-assist";
import type { Api, ApiThreadFeedEvent } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { RecapCard, factPanel, firstSentence, nextStepInsert, withNextStep } from "./recap-card";

const T = "t-deps" as ThreadId;
const ACTIVE = Date.now() - 3 * 60 * 60 * 1000;

const summary = (patch: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({
    thread: { id: T, title: "Bump dependencies", lastActivityAt: ACTIVE },
    status: "idle",
    pendingRequests: [],
    queue: [],
    git: MOCK_DEPS_GIT,
    ...patch,
  }) as ThreadSummary;

const view: RecapView = { threadId: T, recap: MOCK_DEPS_RECAP, lastActiveAt: ACTIVE };

/** The card in a pane that isn't focused until its button is pressed, and each press after flips. */
function FocusLater() {
  const [focused, setFocused] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFocused((f) => !f)}>
        Focus
      </button>
      <RecapCard threadId={T} focused={focused} />
    </>
  );
}

const setup = (answer: RecapView | null = view) => {
  const events: HelperEventPayload[] = [];
  const api: Partial<Api> = {
    threadRecap: vi.fn(async () => answer),
    recordHelperEvent: vi.fn(async (event: HelperEventPayload) => void events.push(event)),
  };
  return { api, events };
};

afterEach(() => {
  cleanup();
  useThreadsStore.setState({ byId: {} });
});

describe("firstSentence", () => {
  it("stops at the first sentence's end", () => {
    expect(firstSentence("You bumped it. Tests pass.")).toBe("You bumped it.");
    expect(firstSentence("No full stop")).toBe("No full stop");
  });
});

describe("recap actions", () => {
  it("opens the diff from the changed files and the PR from its fact, and nothing else", () => {
    const git = { ...MOCK_DEPS_GIT, changedFiles: 3, pr: { number: 12 } } as never;
    expect(factPanel("3 files changed", 0, git)).toBe("diff");
    expect(factPanel("not pushed", 1, git)).toBeUndefined();
    expect(factPanel("#12 open", 2, git)).toBe("pr");
    expect(factPanel("pushed", 0, { ...MOCK_DEPS_GIT, changedFiles: 0 } as never)).toBeUndefined();
  });

  it("puts the next step after what the composer holds, on its own line", () => {
    expect(withNextStep("", "Run the suite")).toBe("Run the suite");
    expect(nextStepInsert("", "Run the suite")).toBe("Run the suite");
    expect(nextStepInsert("  ", "Run the suite")).toBe("Run the suite");
    expect(nextStepInsert("Also check CI", "Run the suite")).toBe("\nRun the suite");
    expect(nextStepInsert("Also check CI\n", "Run the suite")).toBe("Run the suite");
    expect(withNextStep("Also check CI \n", "Run the suite")).toBe("Also check CI\nRun the suite");
  });
});

describe("RecapCard", () => {
  it("asks once the pane is focused, then shows the recap, what's next and the facts", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const { api, events } = setup();
    renderWithApi(<FocusLater />, api);
    expect(api.threadRecap).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Focus" }));
    const card = await screen.findByRole("region", { name: "Where you left off" });
    expect(card.textContent).toContain("Last active 3h ago");
    expect(card.textContent).toContain("Unit tests pass.");
    expect(screen.getByTestId("recap-next").textContent).toBe("Run the e2e suite against Vite 8.3");
    expect(
      [...screen.getByRole("list", { name: "Facts" }).children].map((li) => li.textContent),
    ).toEqual(["14 files changed", "not pushed", "no PR yet"]);
    expect(screen.queryByTestId("recap-progress")).toBeNull();
    await waitFor(() => expect(events).toEqual([{ kind: "recap", event: "shown" }]));
    expect(api.threadRecap).toHaveBeenCalledTimes(1);
  });

  it("shows how far the thread's plan has got", async () => {
    useThreadsStore.setState({ byId: { [T]: summary({ plan: MOCK_DEPS_PLAN }) } });
    const { api } = setup();
    renderWithApi(<RecapCard threadId={T} focused />, api);
    const progress = await screen.findByTestId("recap-progress");
    expect(progress.textContent?.replace(/\s+/g, " ")).toBe("· 2 of 3");
  });

  it("folds to its first sentence while a request waits, and goes once something happens", async () => {
    useThreadsStore.setState({
      byId: { [T]: summary({ pendingRequests: [{ kind: "question" } as never] }) },
    });
    const { api } = setup();
    renderWithApi(<RecapCard threadId={T} focused />, api);
    const card = await screen.findByRole("region", { name: "Where you left off" });
    expect(card.textContent).toContain("zod 4 type errors.");
    expect(card.textContent).not.toContain("Unit tests pass.");
    expect(screen.queryByTestId("recap-next")).toBeNull();
    act(() =>
      useThreadsStore.setState({
        byId: {
          [T]: summary({
            status: "running",
            thread: { ...summary().thread, lastActivityAt: Date.now() },
          }),
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("recap")).toBeNull());
  });

  it("folds to its first sentence in a pane too short for all of it, with More to read the rest", async () => {
    // happy-dom lays nothing out: the whole recap is 200px tall in a 400px pane, over its quarter.
    const offset = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    try {
      useThreadsStore.setState({ byId: { [T]: summary() } });
      const { api } = setup();
      renderWithApi(
        <div data-pane-root>
          <RecapCard threadId={T} focused />
        </div>,
        api,
      );
      const text = await screen.findByTestId("recap-text");
      expect(text.textContent).toContain("zod 4 type errors.");
      expect(text.textContent).not.toContain("Unit tests pass.");
      expect(screen.getByTestId("recap-next")).toBeTruthy();
      const more = screen.getByRole("button", { name: "More" });
      expect(more.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(more);
      expect(text.textContent).toContain("Unit tests pass.");
      fireEvent.click(screen.getByRole("button", { name: "Less" }));
      expect(text.textContent).not.toContain("Unit tests pass.");
    } finally {
      offset.mockRestore();
      client.mockRestore();
    }
  });

  it("is spent once a turn starts, even when the thread's activity time never reaches it", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const { api } = setup();
    renderWithApi(<RecapCard threadId={T} focused />, api);
    await screen.findByRole("region", { name: "Where you left off" });
    act(() => useThreadsStore.setState({ byId: { [T]: summary({ status: "running" }) } }));
    act(() => useThreadsStore.setState({ byId: { [T]: summary({ status: "idle" }) } }));
    await waitFor(() => expect(screen.queryByTestId("recap")).toBeNull());
  });

  it("never shows a recap whose thread started a turn while it was being made", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const pending = Promise.withResolvers<RecapView>();
    const { api } = setup();
    api.threadRecap = vi.fn(() => pending.promise);
    renderWithApi(<RecapCard threadId={T} focused />, api);
    act(() => useThreadsStore.setState({ byId: { [T]: summary({ status: "running" }) } }));
    await act(async () => pending.resolve(view));
    act(() => useThreadsStore.setState({ byId: { [T]: summary({ status: "idle" }) } }));
    expect(screen.queryByTestId("recap")).toBeNull();
  });

  it("never shows a recap asked for before a turn that has already ended", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const pending = Promise.withResolvers<RecapView>();
    const { api } = setup();
    api.threadRecap = vi.fn(() => pending.promise);
    renderWithApi(<RecapCard threadId={T} focused />, api);
    act(() => useThreadsStore.setState({ byId: { [T]: summary({ status: "running" }) } }));
    act(() => useThreadsStore.setState({ byId: { [T]: summary({ status: "idle" }) } }));
    await act(async () => pending.resolve(view));
    expect(screen.queryByTestId("recap")).toBeNull();
  });

  it("stops saying a recap is coming once its answer lands, focused or not", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const pending = Promise.withResolvers<RecapView | null>();
    const { api } = setup();
    api.threadRecap = vi.fn(() => pending.promise);
    renderWithApi(<FocusLater />, api);
    const focus = screen.getByRole("button", { name: "Focus" });
    fireEvent.click(focus);
    await screen.findByTestId("recap-pending");
    fireEvent.click(focus);
    expect(screen.queryByTestId("recap-pending")).toBeNull();
    await act(async () => pending.resolve(null));
    const next = Promise.withResolvers<RecapView | null>();
    api.threadRecap = vi.fn(() => next.promise);
    fireEvent.click(focus);
    // A new spell of focus waits its own 300 ms before saying so.
    expect(screen.queryByTestId("recap-pending")).toBeNull();
    await act(async () => next.resolve(null));
  });

  it("stops saying a recap is coming when a newer focus's answer lands first", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const first = Promise.withResolvers<RecapView | null>();
    const second = Promise.withResolvers<RecapView | null>();
    const answers = [first.promise, second.promise];
    const { api } = setup();
    api.threadRecap = vi.fn(() => answers.shift()!);
    renderWithApi(<FocusLater />, api);
    const focus = screen.getByRole("button", { name: "Focus" });
    fireEvent.click(focus);
    await screen.findByTestId("recap-pending");
    fireEvent.click(focus);
    fireEvent.click(focus);
    await act(async () => second.resolve(null));
    expect(screen.queryByTestId("recap-pending")).toBeNull();
    await act(async () => first.resolve(null));
  });

  it("takes only the latest focus's answer", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const first = Promise.withResolvers<RecapView | null>();
    const second = Promise.withResolvers<RecapView | null>();
    const answers = [first.promise, second.promise];
    const { api } = setup();
    api.threadRecap = vi.fn(() => answers.shift()!);
    renderWithApi(<FocusLater />, api);
    const focus = screen.getByRole("button", { name: "Focus" });
    fireEvent.click(focus);
    fireEvent.click(focus);
    fireEvent.click(focus);
    await waitFor(() => expect(api.threadRecap).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(null));
    await act(async () => first.resolve(view));
    expect(screen.queryByTestId("recap")).toBeNull();
  });

  it("asks again each time the pane comes back into focus", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const answers: Array<RecapView | null> = [null, view];
    const { api } = setup();
    api.threadRecap = vi.fn(async () => answers.shift() ?? null);
    renderWithApi(<FocusLater />, api);
    const focus = screen.getByRole("button", { name: "Focus" });
    fireEvent.click(focus);
    await waitFor(() => expect(api.threadRecap).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("recap")).toBeNull();
    fireEvent.click(focus);
    fireEvent.click(focus);
    await screen.findByRole("region", { name: "Where you left off" });
    expect(api.threadRecap).toHaveBeenCalledTimes(2);
  });

  it("asks again when the user comes back to the app, the pane focused all along", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const answers: Array<RecapView | null> = [null, view];
    const { api } = setup();
    api.threadRecap = vi.fn(async () => answers.shift() ?? null);
    renderWithApi(<RecapCard threadId={T} focused />, api);
    await waitFor(() => expect(api.threadRecap).toHaveBeenCalledTimes(1));
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("blur")));
    hasFocus.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("focus")));
    await screen.findByRole("region", { name: "Where you left off" });
    expect(api.threadRecap).toHaveBeenCalledTimes(2);
    hasFocus.mockRestore();
  });

  it("counts a quick dismissal as unwanted", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const { api, events } = setup();
    renderWithApi(<RecapCard threadId={T} focused />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss the recap" }));
    await waitFor(() =>
      expect(events).toEqual([
        { kind: "recap", event: "shown" },
        { kind: "recap", event: "dismissedFast" },
      ]),
    );
    await waitFor(() => expect(screen.queryByTestId("recap")).toBeNull());
  });

  it("shows nothing when the thread doesn't deserve a recap", async () => {
    useThreadsStore.setState({ byId: { [T]: summary() } });
    const { api, events } = setup(null);
    renderWithApi(<RecapCard threadId={T} focused />, api);
    await waitFor(() => expect(api.threadRecap).toHaveBeenCalled());
    expect(screen.queryByTestId("recap")).toBeNull();
    expect(events).toEqual([]);
  });
});

const box = (patch: Partial<WrapUpData> = {}): WrapUpData => ({
  id: "wrap-up:turn-2",
  turnId: "turn-2" as TurnId,
  recap: "Bumped 14 packages and the unit tests pass. Nothing is pushed yet.",
  ask: "Push the branch?",
  actions: [
    { kind: "app", action: "push" },
    { kind: "reply", label: "Not yet", message: "Leave it unpushed for now" },
  ],
  at: ACTIVE,
  ...patch,
});
const transcript = (data: WrapUpData | undefined, after: GramUIMessage[] = []) =>
  [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Bump the deps" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        ...(data === undefined ? [] : [{ type: "data-wrap-up", id: data.id, data }]),
        { type: "text", text: "Done." },
      ],
    },
    ...after,
  ] as GramUIMessage[];
const feedOf = (messages: GramUIMessage[]) =>
  async function* threadFeed(_id: ThreadId, signal: AbortSignal) {
    yield { type: "subscribed" } as ApiThreadFeedEvent;
    yield { type: "messages", messages } as ApiThreadFeedEvent;
    yield { type: "caughtUp" } as ApiThreadFeedEvent;
    await new Promise((resolve) => signal.addEventListener("abort", resolve));
  };

describe("RecapCard with the agent's wrap_up", () => {
  // A thread of its own per test: the transcript feed is kept per thread across renders.
  let n = 0;
  const mount = (
    messages: GramUIMessage[],
    options: { status?: ThreadSummary["status"]; answer?: (id: ThreadId) => RecapView } = {},
  ) => {
    const id = `t-wrap-${++n}` as ThreadId;
    useThreadsStore.setState({
      byId: {
        [id]: summary({
          thread: { ...summary().thread, id },
          status: options.status ?? "idle",
          // MOCK_DEPS_GIT is a branch origin hasn't got: a push has something to do.
        }),
      },
    });
    const events: HelperEventPayload[] = [];
    const api: Partial<Api> = {
      threadRecap: vi.fn(async () => options.answer?.(id) ?? null),
      recordHelperEvent: vi.fn(async (event: HelperEventPayload) => void events.push(event)),
      threadFeed: feedOf(messages),
      send: vi.fn(async () => ({ queued: false }) as never),
      pushBranch: vi.fn(async () => ({ branch: "chore/deps", published: true }) as never),
    };
    renderWithApi(<RecapCard threadId={id} focused />, api);
    return { api, events };
  };

  it("shows the turn's box as soon as it ends, with no helper recap and none counted", async () => {
    const { api, events } = mount(transcript(box()));
    const card = await screen.findByRole("region", { name: "Turn recap" });
    expect(screen.getByTestId("wrap-up-recap").textContent).toBe(box().recap);
    expect(screen.getByTestId("wrap-up-ask").textContent).toBe("Push the branch?");
    expect(screen.getAllByTestId("wrap-up-action").map((button) => button.textContent)).toEqual([
      "Publish branch",
      "Not yet",
    ]);
    expect(card.textContent).not.toContain("Last active");
    expect(screen.queryByTestId("recap")).toBeNull();
    await waitFor(() => expect(api.threadRecap).toHaveBeenCalled());
    expect(events).toEqual([]);
  });

  it("sends a reply's message, once, and runs an app action's control", async () => {
    const { api } = mount(transcript(box()));
    const notYet = await screen.findByRole("button", { name: "Not yet" });
    // What it sends in your name says more than its label, so it's on the button too.
    expect(notYet.getAttribute("aria-description")).toBe("Sends: Leave it unpushed for now");
    fireEvent.click(notYet);
    fireEvent.click(notYet);
    await waitFor(() =>
      expect(api.send).toHaveBeenCalledWith(expect.any(String), {
        text: "Leave it unpushed for now",
      }),
    );
    expect(api.send).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Publish branch" }));
    await waitFor(() => expect(api.pushBranch).toHaveBeenCalledTimes(1));
  });

  it("sends one answer per box, whichever buttons are pressed while it's on its way", async () => {
    const sent = Promise.withResolvers<{ queued: boolean }>();
    const { api } = mount(
      transcript(
        box({
          actions: [
            { kind: "reply", label: "Yes", message: "Yes" },
            { kind: "reply", label: "No", message: "No" },
          ],
        }),
      ),
    );
    vi.mocked(api.send!).mockImplementation(() => sent.promise as never);
    fireEvent.click(await screen.findByRole("button", { name: "Yes" }));
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledWith(expect.any(String), { text: "Yes" });
    await act(async () => sent.resolve({ queued: false }));
  });

  it("leaves out a button with nothing to do, and the buttons of a box with no question", async () => {
    mount(transcript(box({ actions: [{ kind: "app", action: "merge" }, box().actions[1]!] })));
    await screen.findByRole("region", { name: "Turn recap" });
    expect(screen.getAllByTestId("wrap-up-action").map((b) => b.textContent)).toEqual(["Not yet"]);
    cleanup();
    const { ask: _ask, ...noAsk } = box();
    mount(transcript(noAsk));
    await screen.findByRole("region", { name: "Turn recap" });
    expect(screen.queryByTestId("wrap-up-ask")).toBeNull();
    expect(screen.queryByTestId("wrap-up-action")).toBeNull();
  });

  it("shows nothing while a turn runs, or once the user has answered", async () => {
    const running = mount(transcript(box()), { status: "running" });
    await waitFor(() => expect(running.api.threadRecap).toHaveBeenCalled());
    expect(screen.queryByTestId("wrap-up")).toBeNull();
    cleanup();
    const answered = mount(
      transcript(box(), [
        { id: "u2", role: "user", parts: [{ type: "text", text: "Not yet" }] } as GramUIMessage,
      ]),
    );
    await waitFor(() => expect(answered.api.threadRecap).toHaveBeenCalled());
    expect(screen.queryByTestId("wrap-up")).toBeNull();
  });

  it("is where you left off when the server serves it on a later open, and can be dismissed", async () => {
    const data = box();
    mount(transcript(data), {
      answer: (threadId) => ({
        threadId,
        recap: { recap: data.recap, next: null, replies: [] },
        lastActiveAt: ACTIVE,
        turnId: data.turnId,
        wrapUp: data,
      }),
    });
    const card = await screen.findByRole("region", { name: "Where you left off" });
    expect(card.textContent).toContain("Last active 3h ago");
    expect(screen.queryByTestId("recap")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the recap" }));
    await waitFor(() => expect(screen.queryByTestId("wrap-up")).toBeNull());
  });
});

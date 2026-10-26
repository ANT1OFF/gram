// @vitest-environment happy-dom
import type { GramUIMessage, GramUIMessageChunk, MessageId, ThreadId } from "@gram/contracts";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import type { ApiThreadFeedEvent } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { ThreadView } from "./thread-view";
import type * as ToolCards from "./tool-cards";

type ToolCardsModule = typeof ToolCards;

// NumberFlow's custom element doesn't upgrade in happy-dom, so an animated ticker throws on update.
vi.mock("@/motion/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

/** Counts each tool card's renders by its tool call id. */
const cards = vi.hoisted(() => ({ renders: new Map<string, number>() }));
vi.mock("./tool-cards", async (original) => {
  const actual = await original<ToolCardsModule>();
  return {
    ...actual,
    ToolCard: (props: Parameters<typeof actual.ToolCard>[0]) => {
      const id = props.part.toolCallId;
      cards.renders.set(id, (cards.renders.get(id) ?? 0) + 1);
      return <actual.ToolCard {...props} />;
    },
  };
});

const THREAD = "t-docs" as ThreadId;

/** A turn whose Task ran a subagent to the end, before the reply under test streams. */
const HISTORY = [
  {
    id: "u1",
    role: "user",
    metadata: { turnId: "turn-1" },
    parts: [{ type: "text", text: "Find the flaky tests" }],
  },
  {
    id: "a1",
    role: "assistant",
    metadata: { turnId: "turn-1" },
    parts: [
      {
        type: "tool-Task",
        toolCallId: "task-1",
        state: "output-available",
        input: {
          description: "Find sleep-based tests",
          prompt: "Search for tests that await real timers.",
          subagent_type: "Explore",
        },
        output: { status: "completed", content: [{ type: "text", text: "Two files." }] },
      },
      {
        type: "data-subagent-usage",
        id: "task-1",
        data: {
          toolCallId: "task-1",
          status: "completed",
          totalTokens: 900,
          toolUses: 1,
          durationMs: 1_200,
        },
      },
      { type: "text", text: "Found two.", state: "done" },
    ],
  },
  {
    id: "s1",
    role: "assistant",
    metadata: { parentToolUseId: "task-1" },
    parts: [{ type: "text", text: "Searching for `await sleep(`.", state: "done" }],
  },
  {
    id: "u2",
    role: "user",
    metadata: { turnId: "turn-2" },
    parts: [{ type: "text", text: "Now fix them" }],
  },
] as unknown as GramUIMessage[];

/** A feed that sends `HISTORY`, then whatever the test pushes. */
function controlledFeed() {
  const queue: ApiThreadFeedEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (...events: ApiThreadFeedEvent[]) => {
    queue.push(...events);
    wake?.();
  };
  async function* threadFeed(
    _threadId: ThreadId,
    signal: AbortSignal,
  ): AsyncIterable<ApiThreadFeedEvent> {
    yield { type: "subscribed" };
    yield { type: "messages", messages: HISTORY } as ApiThreadFeedEvent;
    yield { type: "caughtUp", rev: 1 } as ApiThreadFeedEvent;
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
  return { threadFeed, push };
}

const chunk = (c: GramUIMessageChunk): ApiThreadFeedEvent => ({
  type: "chunk",
  messageId: "a2" as MessageId,
  chunk: c,
});

/** Lets the feed deliver what was pushed and the frame after it publish. */
const nextFrame = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });

let api: MockApi;

beforeEach(async () => {
  cards.renders.clear();
  // happy-dom lays nothing out; a tall viewport lets the virtualized transcript render its rows.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width: 800, height: 4_000 }),
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(4_000);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
  // The virtualizer sizes its scroll viewport by client dimensions (virtual-core 3.19.6+).
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(4_000);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  api = createMockApi({ speed: 0, autoplay: false });
  const abort = new AbortController();
  for await (const event of api.events(abort.signal)) {
    useThreadsStore.getState().applyEvent(event);
    if (event.type === "threads.snapshot") break;
  }
  abort.abort();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadView while a reply streams", () => {
  it("leaves a finished Task row alone while the reply under it grows", async () => {
    const feed = controlledFeed();
    renderWithApi(
      <ThreadView threadId={THREAD} focused={false} />,
      Object.assign(Object.create(api) as MockApi, { threadFeed: feed.threadFeed }),
    );
    expect(await screen.findByText("Find sleep-based tests")).toBeTruthy();
    feed.push(chunk({ type: "start", messageId: "a2" }), chunk({ type: "text-start", id: "t" }));
    await nextFrame();
    await waitFor(() => expect(document.querySelector('[data-message-id="a2"]')).not.toBeNull());
    const settled = cards.renders.get("task-1") ?? 0;
    expect(settled).toBeGreaterThan(0);

    for (let frame = 0; frame < 10; frame++) {
      feed.push(chunk({ type: "text-delta", id: "t", delta: `word${frame} ` }));
      await nextFrame();
    }
    expect(await screen.findByText(/word0 word1 .*word9/)).toBeTruthy();
    expect(cards.renders.get("task-1")).toBe(settled);
  });
});

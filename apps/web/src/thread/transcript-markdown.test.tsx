// @vitest-environment happy-dom
import type { GramUIMessage, ThreadId } from "@gram/contracts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import type { ApiThreadFeedEvent } from "@/api/types";
import { renderWithApi } from "@/panels/test-utils";
import { useThreadsStore } from "@/stores/threads";

import { ThreadView } from "./thread-view";

// Streamdown's module resolves only when the test lets it, as a slow chunk would.
const markdownGate = vi.hoisted(() => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, release: resolve };
});
vi.mock("@/components/ai-elements/markdown", async (importOriginal) => {
  await markdownGate.opened;
  return importOriginal();
});

// NumberFlow's custom element doesn't upgrade in happy-dom, so an animated ticker throws on update.
vi.mock("@/motion/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

const THREAD = "t-docs" as ThreadId;

const HISTORY = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Show me the retry" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "text", text: "Use **backoff**:\n\n```ts\nawait retry(fn);\n```", state: "done" },
    ],
  },
] as unknown as GramUIMessage[];

async function* threadFeed(): AsyncIterable<ApiThreadFeedEvent> {
  yield { type: "subscribed" };
  yield { type: "messages", messages: HISTORY } as ApiThreadFeedEvent;
  yield { type: "caughtUp", rev: 1 } as ApiThreadFeedEvent;
}

let api: MockApi;

beforeEach(async () => {
  // happy-dom lays nothing out; a tall viewport lets the virtualized transcript render its rows.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    DOMRect.fromRect({ width: 800, height: 4_000 }),
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(4_000);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
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

describe("the transcript while streamdown loads", () => {
  it("keeps saying it's loading, then lays out the rows once, as markdown", async () => {
    const { container } = renderWithApi(
      <ThreadView threadId={THREAD} focused={false} />,
      Object.assign(Object.create(api) as MockApi, { threadFeed }),
    );
    // The messages are in, but no row is laid out, as plain text or otherwise, without markdown.
    await waitFor(() => expect(useThreadsStore.getState().byId[THREAD]).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("Loading conversation…")).toBeTruthy();
    expect(container.querySelector("[data-message-id]")).toBeNull();
    expect(container.textContent).not.toContain("backoff");

    markdownGate.release();
    await waitFor(() => expect(container.querySelector('[data-message-id="a1"]')).not.toBeNull(), {
      timeout: 10_000,
    });
    expect(screen.queryByText("Loading conversation…")).toBeNull();
    expect(screen.queryByTestId("markdown-pending")).toBeNull();
    expect(
      screen.getByText("backoff").closest("strong, [data-streamdown='strong']"),
    ).not.toBeNull();
  }, 20_000);
});

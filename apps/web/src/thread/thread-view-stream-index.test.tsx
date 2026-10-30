// @vitest-environment happy-dom
import type { GramUIMessage, ThreadId } from "@gram/contracts";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createMockApi, type MockApi } from "@/api/mock";
import type * as StreamContextModule from "@/orchestration/stream-context";
import { renderWithApi } from "@/panels/test-utils";
import { feedMessages } from "@/stores/feeds";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import { ThreadView } from "./thread-view";
import type { Transcript } from "./transcript";
import type * as TranscriptModule from "./transcript";

// An orchestrator's transcript leaves folded digests out, so it has fewer rows than the thread has
// messages. What ThreadView hands it by position must count its rows, or a search hit lands off by
// however many were folded.

type TranscriptProps = ComponentProps<typeof Transcript>;

const seen = vi.hoisted(() => ({
  props: undefined as unknown,
  streams: new WeakMap<object, unknown>(),
}));
const props = () => seen.props as TranscriptProps;

vi.mock("@/motion/number-ticker", () => ({
  NumberTicker: ({ value }: { value: number }) => <span>{value}</span>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => children,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));
vi.mock("./transcript", async (original) => ({
  ...(await original<typeof TranscriptModule>()),
  Transcript: (received: unknown) => {
    seen.props = received;
    return <div data-testid="transcript" />;
  },
}));
vi.mock("@/orchestration/since-you-left", () => ({ SinceYouLeftCard: () => null }));
// A stream that folds the thread's first message, as a digest folded into a later one's line.
vi.mock("@/orchestration/stream-context", async (original) => ({
  ...(await original<typeof StreamContextModule>()),
  OrchestratorStreamProvider: ({ children }: { children: ReactNode }) => children,
  useOrchestratorStream: (_thread: unknown, messages: readonly GramUIMessage[]) => {
    // One stream per history, as the real hook memoizes it.
    let stream = seen.streams.get(messages);
    if (stream === undefined) {
      stream = { plan: { messages: messages.slice(1), extras: new Map(), digests: [] } };
      seen.streams.set(messages, stream);
    }
    return stream;
  },
}));

const DEPS = "t-deps" as ThreadId;
let api: MockApi;

beforeEach(async () => {
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
  seen.props = undefined;
});

it("counts a search hit's position in the rows the transcript shows, not the thread's messages", async () => {
  renderWithApi(<ThreadView threadId={DEPS} focused />, api);
  await screen.findByTestId("transcript");
  await vi.waitFor(() => expect(feedMessages(DEPS).length).toBeGreaterThan(1));
  await waitFor(() => expect(props().messages.length).toBeGreaterThan(0));
  const { messages } = props();
  const hit = messages.at(-1)!;

  act(() => useRevealStore.getState().reveal(DEPS, hit.id));

  await waitFor(() => expect(props().reveal).toBeDefined());
  expect(props().messages[props().reveal!.index]?.id).toBe(hit.id);
});

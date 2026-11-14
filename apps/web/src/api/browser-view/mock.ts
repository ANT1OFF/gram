import type { BrowserViewEvent, BrowserViewPage, ThreadId } from "@gram/contracts";

import { createChannel, type Channel } from "../channel";
import { mockServerBrowser } from "../mock-overrides";
import { mockPageFrame } from "./mock-frame";
import type { BrowserViewApi, BrowserViewFeedEvent } from "./types";

type Status = Extract<BrowserViewEvent, { type: "page" }>["status"];

/** A thread's page on the mock server, as `simulateServerPage` stages it. */
export interface MockServerPage {
  /** The page; `null` or absent while the thread has none. Unset fields are a loaded page's. */
  readonly page?: Partial<BrowserViewPage> | null | undefined;
  /** Why there is no page: the browser is starting, or couldn't open one. */
  readonly status?: Status;
  /** The connection to the server is lost after the page and its frame have come. */
  readonly dropped?: boolean | undefined;
  /** The frame drawn, a synthetic page unless given; `null` sends none. */
  readonly frame?: Extract<BrowserViewEvent, { type: "frame" }> | null | undefined;
}

export interface BrowserViewMockControls {
  /** Dev and e2e hook: the thread's page in the server's browser, sent to whoever watches it. */
  simulateServerPage(threadId: ThreadId, scene: MockServerPage): void;
  /** What `browserViewControl` was asked, oldest first. */
  readonly serverPageControls: { threadId: ThreadId; op: string }[];
}

const eventsOf = (scene: MockServerPage): BrowserViewFeedEvent[] => {
  const page: BrowserViewPage | null =
    scene.page == null
      ? null
      : {
          url: "http://localhost:5173/invoices",
          title: "Invoices",
          loading: false,
          canGoBack: true,
          canGoForward: false,
          driver: "agent",
          ...scene.page,
        };
  const events: BrowserViewFeedEvent[] = [
    { type: "page", page, ...(scene.status === undefined ? {} : { status: scene.status }) },
  ];
  if (page !== null && scene.frame !== null) events.push(scene.frame ?? mockPageFrame());
  if (scene.dropped === true) events.push({ type: "dropped" });
  return events;
};

/**
 * The mock server runs no browser of its own, and its feed says so as a real one without it does,
 * unless `MOCK_SERVER_BROWSER_KEY` is set: then each thread has the page staged for it, and taking
 * it over and handing it back change who drives.
 */
export const createBrowserViewMock = (): BrowserViewApi & BrowserViewMockControls => {
  const scenes = new Map<ThreadId, MockServerPage>();
  const watchers = new Map<ThreadId, Set<Channel<BrowserViewFeedEvent>>>();
  const serverPageControls: BrowserViewMockControls["serverPageControls"] = [];
  const stage = (threadId: ThreadId, scene: MockServerPage) => {
    scenes.set(threadId, scene);
    for (const channel of watchers.get(threadId) ?? [])
      for (const event of eventsOf(scene)) channel.push(event);
  };
  const drive = (threadId: ThreadId, driver: "agent" | "user") => {
    const scene = scenes.get(threadId);
    if (scene?.page == null || (scene.page.driver ?? "agent") === driver) return;
    stage(threadId, { ...scene, page: { ...scene.page, driver } });
  };
  return {
    browserViewFeed: (threadId, signal) => {
      if (!mockServerBrowser()) {
        // eslint-disable-next-line require-yield
        return (async function* (): AsyncGenerator<BrowserViewFeedEvent> {
          throw Object.assign(new Error("This server runs no browser of its own."), {
            _tag: "InvalidState",
          });
        })();
      }
      const set = watchers.get(threadId) ?? new Set();
      watchers.set(threadId, set);
      const channel = createChannel<BrowserViewFeedEvent>(signal, () => set.delete(channel));
      set.add(channel);
      for (const event of eventsOf(scenes.get(threadId) ?? {})) channel.push(event);
      return channel;
    },
    browserViewInput: async (threadId, inputs) => {
      // A pointer passing over the agent's page takes nothing over.
      if (inputs.some((input) => input.type !== "pointer" || input.action !== "move"))
        drive(threadId, "user");
    },
    browserViewControl: async (threadId, op) => {
      serverPageControls.push({ threadId, op });
      if (op === "handBack") drive(threadId, "agent");
    },
    simulateServerPage: stage,
    serverPageControls,
  };
};

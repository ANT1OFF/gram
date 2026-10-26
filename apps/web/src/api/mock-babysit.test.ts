import type { ThreadId } from "@gram/contracts";
import { describe, expect, it } from "vitest";

import { createThreadFeed, syncScheduler } from "@/stores/thread-feed";

import { createMockApi } from "./mock";
import type { ApiServerEvent } from "./types";

async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("MockApi babysit", () => {
  it("binds the PR, then queues a review notice and counts the round", async () => {
    const api = createMockApi({ speed: 0, autoplay: false });
    const abort = new AbortController();
    const events: ApiServerEvent[] = [];
    void (async () => {
      for await (const event of api.events(abort.signal)) events.push(event);
    })();
    const feed = createThreadFeed({ scheduler: syncScheduler });
    void (async () => {
      for await (const event of api.threadFeed("t-flaky" as ThreadId, abort.signal)) {
        feed.apply(event);
      }
    })();

    const thread = await api.threadSetBabysit("t-flaky" as ThreadId, true, { rounds: 3 });
    expect(thread.boundPr).toEqual({
      repo: "example/api",
      number: 412,
      monitor: false,
      reviewMonitor: true,
    });
    expect(thread.babysit).toMatchObject({ phase: "watching", budget: { rounds: 3 }, rounds: 0 });

    await waitFor(
      () =>
        feed.store
          .getState()
          .messages.some((m) => m.parts.some((p) => p.type === "data-review-notice")),
      "review notice",
    );
    const notice = feed.store.getState().messages.at(-1)!;
    expect(notice.role).toBe("user");
    expect(notice.parts[0]).toMatchObject({ type: "text", text: /^Review update on #412/ });
    await waitFor(
      () => events.some((e) => e.type === "thread.upsert" && e.thread.babysit?.rounds === 1),
      "round counted",
    );

    const off = await api.threadSetBabysit("t-flaky" as ThreadId, false);
    expect(off.babysit).toBeUndefined();
    await expect(api.threadSetBabysit("t-docs" as ThreadId, true)).rejects.toMatchObject({
      _tag: "InvalidState",
    });
    abort.abort();
  });
});

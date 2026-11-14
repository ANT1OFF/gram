import type { ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { createThreadsSlice, type ThreadsState } from "@/stores/threads";

import { createMockApi } from "./mock";

describe("mock threads started before their machine", () => {
  it.each([{}, { failed: "No capacity in this region." }])(
    "publishes the held messages to clients already connected (%j)",
    async (awaitingMachine) => {
      const api = createMockApi({ speed: 0, autoplay: false });
      const threads = createStore<ThreadsState>()((set) => createThreadsSlice(set));
      const abort = new AbortController();
      const watching = (async () => {
        for await (const event of api.events(abort.signal)) threads.getState().applyEvent(event);
      })();
      const id = "t-machine-wait" as ThreadId;
      try {
        await vi.waitFor(() => expect(threads.getState().ready).toBe(true));
        await api.simulateThread({
          id,
          title: "Release notes",
          awaitingMachine,
          messages: [
            { role: "user", text: "Draft the release notes." },
            { role: "user", text: "Keep them under 300 words." },
          ],
        });
        await vi.waitFor(() =>
          expect(threads.getState().byId[id]?.queue.map((item) => item.input.text)).toEqual([
            "Draft the release notes.",
            "Keep them under 300 words.",
          ]),
        );
      } finally {
        abort.abort();
        await watching;
      }
    },
  );
});

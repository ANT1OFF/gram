import type { MessageId, ThreadId } from "@gram/contracts";
import { describe, expect, it, vi } from "vitest";

import { createMockApi } from "./mock";

const newApi = () => createMockApi({ speed: 0, autoplay: false });
const T_DEPS = "t-deps" as ThreadId;

describe("MockApi fork and search", () => {
  it("forks at a reply, keeping only the history up to it", async () => {
    const api = newApi();
    await api.send(T_DEPS, { text: "also update the changelog" });
    await vi.waitFor(async () => {
      expect((await api.searchThreads("changelog", { threadId: T_DEPS })).hits).not.toHaveLength(0);
    });

    // The mock refuses while the echo turn still runs, as the server does.
    const fork = await vi.waitFor(() =>
      api.forkThread(T_DEPS, { fromMessageId: "m-d2" as MessageId }),
    );
    expect(fork.forkedFrom).toEqual({ threadId: T_DEPS });
    expect(fork.title).toMatch(/^Fork of /);

    const scoped = { threadId: fork.id };
    expect((await api.searchThreads("packages", scoped)).hits).toHaveLength(1);
    expect((await api.searchThreads("changelog", scoped)).hits).toHaveLength(0);
  });

  it("refuses a fork point without agent ids and an unknown message", async () => {
    const api = newApi();
    await expect(api.forkThread(T_DEPS, { fromMessageId: "m-d1" as MessageId })).rejects.toThrow(
      "InvalidState",
    );
    await expect(api.forkThread(T_DEPS, { fromMessageId: "nope" as MessageId })).rejects.toThrow(
      "NotFound",
    );
    const whole = await api.forkThread("t-dark" as ThreadId);
    expect((await api.searchThreads("localStorage", { threadId: whole.id })).hits).toHaveLength(1);
  });

  it("searches across threads with snippets and reports truncation", async () => {
    const api = newApi();
    const result = await api.searchThreads("dark mode tog");
    const hit = result.hits.find((h) => h.messageId === "m-k1");
    expect(hit).toMatchObject({ threadId: "t-dark" });
    expect(hit?.highlights).toHaveLength(3);

    const limited = await api.searchThreads("the", { limit: 1 });
    expect(limited.hits).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect((await api.searchThreads("?!")).hits).toHaveLength(0);
  });
});

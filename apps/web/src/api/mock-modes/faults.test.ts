// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { tagOf } from "../errors";
import { withFaults } from "./faults";

class Api {
  calls = 0;
  async save(value: number) {
    this.calls++;
    return value * 2;
  }
  subscribe() {
    return "unsubscribe";
  }
  async refuse(): Promise<never> {
    throw Object.assign(new Error("no adapter"), { _tag: "AgentUnavailable" });
  }
}

afterEach(() => {
  vi.useRealTimers();
  delete window.gramMockFaults;
});

describe("withFaults", () => {
  it("fails an async call before it runs, or delays its real result, and records each", async () => {
    vi.useFakeTimers();
    const api = new Api();
    const faulty = withFaults(api, { rate: 1, seed: 3, maxDelayMs: 1000 });
    const outcomes: string[] = [];
    for (let index = 0; index < 40; index++) {
      const call = faulty.save(index).then(
        (value) => outcomes.push(value === index * 2 ? "ok" : "wrong"),
        (error: unknown) => outcomes.push(tagOf(error) ?? "untagged"),
      );
      await vi.runAllTimersAsync();
      await call;
    }
    const faults = window.gramMockFaults ?? [];
    expect(faults).toHaveLength(40);
    const failedBeforeRunning = faults.filter((f) => f.kind === "server" || f.kind === "network");
    expect(failedBeforeRunning.length).toBeGreaterThan(0);
    // A server or network failure never reached the api; a slow call or a timeout did.
    expect(api.calls).toBe(40 - failedBeforeRunning.length);
    expect(outcomes).not.toContain("wrong");
    expect(outcomes).not.toContain("untagged");
  });

  it("keeps a slowed call's own rejection handled while it waits", async () => {
    vi.useFakeTimers();
    let unhandled = 0;
    const count = () => unhandled++;
    process.on("unhandledRejection", count);
    try {
      const faulty = withFaults(new Api(), { rate: 1, seed: 3, maxDelayMs: 1000 });
      const tags: unknown[] = [];
      for (let index = 0; index < 20; index++) {
        const call = faulty.refuse().catch((error: unknown) => tags.push(tagOf(error)));
        await vi.runAllTimersAsync();
        await call;
      }
      expect((window.gramMockFaults ?? []).some((f) => f.kind === "slow")).toBe(true);
      expect(tags).toContain("AgentUnavailable");
      expect(unhandled).toBe(0);
    } finally {
      process.off("unhandledRejection", count);
    }
  });

  it("leaves synchronous members and calls it doesn't draw alone", async () => {
    const api = new Api();
    const faulty = withFaults(api, { rate: 1, seed: 3 });
    expect(faulty.subscribe()).toBe("unsubscribe");
    await expect(withFaults(new Api(), { rate: 0, seed: 3 }).save(2)).resolves.toBe(4);
    expect(faulty.save).toBe(faulty.save);
  });
});

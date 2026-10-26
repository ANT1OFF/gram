import { describe, expect, it } from "vitest";

import { serialized } from "./watch.ts";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("serialized native watcher calls", () => {
  it("runs one at a time, in call order, even when started together", async () => {
    let running = 0;
    let peak = 0;
    const order: Array<number> = [];
    const call = (id: number, ms: number) =>
      serialized(async () => {
        running++;
        peak = Math.max(peak, running);
        await tick(ms);
        order.push(id);
        running--;
        return id;
      });

    expect(await Promise.all([call(1, 30), call(2, 5), call(3, 15)])).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("still reports a failed call, and runs the next one after it", async () => {
    const failing = serialized(async () => {
      throw new Error("no such folder");
    });
    const next = serialized(async () => "subscribed");
    await expect(failing).rejects.toThrow("no such folder");
    await expect(next).resolves.toBe("subscribed");
  });
});

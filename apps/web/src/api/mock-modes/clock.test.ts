import { describe, expect, it } from "vitest";

import { MockClock } from "./clock";

const start = { now: 0, until: 0 };

describe("MockClock", () => {
  it("runs only what the steps have granted, in due order, however long the wall clock waits", async () => {
    const clock = new MockClock(start, 1000, (error) => {
      throw error;
    });
    const fired: string[] = [];
    clock.setTimer(() => fired.push("b@600"), 600, false);
    clock.setTimer(() => fired.push("a@200"), 200, false);
    clock.setTimer(() => fired.push("c@1500"), 1500, false);
    await clock.settle();
    expect(fired).toEqual([]);

    clock.step();
    await clock.settle();
    expect(fired).toEqual(["a@200", "b@600"]);
    expect(clock.now()).toBe(600);

    clock.step();
    await clock.settle();
    expect(fired).toEqual(["a@200", "b@600", "c@1500"]);
  });

  it("lets an awaited sleep schedule the next one within the same step", async () => {
    const clock = new MockClock(start, 1000, (error) => {
      throw error;
    });
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => clock.setTimer(resolve, ms, false));
    const seen: number[] = [];
    void (async () => {
      for (let index = 0; index < 5; index++) {
        await sleep(300);
        seen.push(clock.now());
      }
    })();
    clock.step();
    await clock.settle();
    expect(seen).toEqual([300, 600, 900]);
  });

  it("ends a timer that re-arms itself at 0 ms instead of spinning", async () => {
    const clock = new MockClock(start, 50, (error) => {
      throw error;
    });
    let runs = 0;
    const id = clock.setTimer(() => runs++, 0, true);
    clock.step();
    await clock.settle();
    expect(runs).toBe(50);
    clock.clearTimer(id);
    clock.step();
    await clock.settle();
    expect(runs).toBe(50);
  });
});

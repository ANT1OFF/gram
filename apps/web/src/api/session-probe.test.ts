import { describe, expect, it, vi } from "vitest";

import { createConnectionMonitor, withSessionProbe, type ProbeAnswer } from "./connection";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const noop = () => {};

describe("withSessionProbe", () => {
  it("probes once per reconnect wave, however many subscriptions drop, and again after reopening", async () => {
    const probe = vi.fn(async (): Promise<ProbeAnswer> => "unknown");
    const connection = withSessionProbe(createConnectionMonitor(), probe);
    const subscriptions = [Symbol("events"), Symbol("windows"), Symbol("feed")];
    for (const id of subscriptions) connection.opened(id);

    for (const id of subscriptions) connection.failed(id, 1, Date.now() + 500);
    await settle();
    expect(probe).toHaveBeenCalledTimes(1);

    // The next wave: a server still down, or one that restarted with a new launch token.
    for (const id of subscriptions) connection.failed(id, 2, Date.now() + 1000);
    await settle();
    expect(probe).toHaveBeenCalledTimes(2);

    for (const id of subscriptions) connection.opened(id);
    connection.failed(subscriptions[0]!, 1, Date.now() + 500);
    await settle();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(connection.get().status).toBe("reconnecting");
  });

  it("doesn't start a probe while one is still out", async () => {
    let answer: (value: ProbeAnswer) => void = noop;
    const probe = vi.fn(
      () =>
        new Promise<ProbeAnswer>((resolve) => {
          answer = resolve;
        }),
    );
    const connection = withSessionProbe(createConnectionMonitor(), probe);
    const id = Symbol("events");
    connection.failed(id, 1, Date.now() + 500);
    connection.failed(id, 2, Date.now() + 1000);
    expect(probe).toHaveBeenCalledTimes(1);

    answer("unknown");
    await settle();
    connection.failed(id, 3, Date.now() + 2000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("expires the connection when the server rejects the session", async () => {
    const connection = withSessionProbe(createConnectionMonitor(), async () => "rejected" as const);
    const id = Symbol("events");
    connection.opened(id);
    connection.failed(id, 1, Date.now() + 500);
    await settle();
    expect(connection.get().status).toBe("expired");
  });

  it("carries a probe's notice while reconnecting, and forgets it once the connection reopens", async () => {
    const moving = { message: "Moving your workspace to a fresh VM…", detail: "Saving your work." };
    const probe = vi.fn(async (): Promise<ProbeAnswer> => moving);
    const connection = withSessionProbe(createConnectionMonitor(), probe);
    const id = Symbol("events");
    connection.opened(id);
    connection.failed(id, 1, Date.now() + 500);
    await settle();
    expect(connection.get()).toMatchObject({ status: "reconnecting", notice: moving });

    // The next wave's probe met a plain outage: the banner goes back to "Reconnecting".
    probe.mockResolvedValueOnce("unknown");
    connection.failed(id, 2, Date.now() + 1000);
    await settle();
    expect(connection.get().notice).toBeUndefined();

    connection.failed(id, 3, Date.now() + 2000);
    await settle();
    expect(connection.get().notice).toEqual(moving);
    connection.opened(id);
    expect(connection.get()).toEqual({ status: "open" });
    // A probe answering after the reopen doesn't bring the notice back.
    connection.explain(moving);
    expect(connection.get()).toEqual({ status: "open" });
  });
});

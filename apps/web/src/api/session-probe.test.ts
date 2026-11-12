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

  it("refreshes an embedded session once and wakes retries without expiring it", async () => {
    let finish!: (value: boolean) => void;
    const refresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const expired = vi.fn();
    const control = createConnectionMonitor();
    const retry = vi.spyOn(control, "retryNow");
    const connection = withSessionProbe(control, async () => "rejected", { refresh, expired });
    const id = Symbol("feed");
    connection.opened(id);
    connection.failed(id, 1, Date.now());
    await settle();
    const other = Symbol("other");
    connection.failed(other, 1, Date.now());
    connection.failed(id, 2, Date.now());
    expect(refresh).toHaveBeenCalledTimes(1);
    finish(true);
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(expired).not.toHaveBeenCalled();
    expect(connection.get().status).toBe("reconnecting");
    connection.opened(id);
    connection.opened(other);
    expect(connection.get().status).toBe("open");
  });

  it("hands an ended embedded session to its app's sign-in", async () => {
    const expired = vi.fn();
    const connection = withSessionProbe(createConnectionMonitor(), async () => "rejected", {
      refresh: async () => false,
      expired,
    });
    connection.failed(Symbol("feed"), 1, Date.now());
    await settle();
    expect(expired).toHaveBeenCalledTimes(1);
    expect(connection.get().status).toBe("expired");
  });

  it("retries a temporary refresh outage on the next wave", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
    const expired = vi.fn();
    const connection = withSessionProbe(createConnectionMonitor(), async () => "rejected", {
      refresh,
      expired,
    });
    const id = Symbol("feed");
    connection.failed(id, 1, Date.now());
    await settle();
    expect(connection.get().status).toBe("reconnecting");
    connection.failed(id, 2, Date.now());
    await settle();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(expired).not.toHaveBeenCalled();
  });

  it.each([true, false])("ignores a stale refresh reply (%s) after reopening", async (answer) => {
    let finish!: (value: boolean) => void;
    const expired = vi.fn();
    const connection = withSessionProbe(createConnectionMonitor(), async () => "rejected", {
      refresh: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
      expired,
    });
    const id = Symbol("feed");
    connection.failed(id, 1, Date.now());
    await settle();
    connection.opened(id);
    // Even a new drop can't make the previous wave's answer current.
    connection.failed(id, 1, Date.now());
    finish(answer);
    await settle();
    expect(connection.get().status).toBe("reconnecting");
    expect(expired).not.toHaveBeenCalled();
  });

  it("ignores a stale desktop 401 after the connection reopened", async () => {
    let finish!: (value: ProbeAnswer) => void;
    const connection = withSessionProbe(
      createConnectionMonitor(),
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const id = Symbol("feed");
    connection.failed(id, 1, Date.now());
    connection.opened(id);
    finish("rejected");
    await settle();
    expect(connection.get().status).toBe("open");
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

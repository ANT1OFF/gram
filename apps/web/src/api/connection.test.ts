import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Socket from "effect/socket/Socket";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getEventListeners } from "node:events";

import { createChannel } from "./channel";

import {
  backoffDelay,
  createConnectionMonitor,
  resubscribing,
  whenReconnected,
} from "./connection";
import { iterate } from "./rpc-client";
import { rpcProtocolLayer, transportRetryDelay } from "./rpc-protocol";

async function waitFor(predicate: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("whenReconnected", () => {
  it("lets a command through at once unless the connection dropped", async () => {
    const monitor = createConnectionMonitor();
    // Never open yet (no feed has answered): the socket itself waits, so nothing does here.
    await expect(whenReconnected(monitor, 10)).resolves.toBe(true);
    const id = Symbol("events");
    monitor.opened(id);
    await expect(whenReconnected(monitor, 10)).resolves.toBe(true);
  });

  it("waits for a dropped connection, asking for a retry now, and gives up after the limit", async () => {
    const monitor = createConnectionMonitor();
    const id = Symbol("events");
    monitor.opened(id);
    monitor.failed(id, 1, Date.now() + 10_000);
    const retried = vi.spyOn(monitor, "retryNow");
    const back = whenReconnected(monitor, 1000);
    expect(retried).toHaveBeenCalledTimes(1);
    monitor.opened(id);
    await expect(back).resolves.toBe(true);

    monitor.failed(id, 1, Date.now() + 10_000);
    await expect(whenReconnected(monitor, 5)).resolves.toBe(false);
    const expiring = whenReconnected(monitor, 1000);
    monitor.expire();
    await expect(expiring).resolves.toBe(false);
  });
});

describe("backoffDelay", () => {
  it("doubles from the base, caps, and jitters by ±20 %", () => {
    expect(backoffDelay(1, { random: () => 0.5 })).toBe(500);
    expect(backoffDelay(3, { random: () => 0.5 })).toBe(2000);
    expect(backoffDelay(20, { random: () => 0.5 })).toBe(10_000);
    expect(backoffDelay(1, { random: () => 0 })).toBe(400);
    expect(backoffDelay(1, { random: () => 1 })).toBe(600);
  });
});

describe("transportRetryDelay", () => {
  it("retries quickly three times, then backs off to a 5 s cap", () => {
    expect(Array.from({ length: 10 }, (_, i) => transportRetryDelay(i + 1))).toEqual([
      500, 500, 500, 1000, 2000, 4000, 5000, 5000, 5000, 5000,
    ]);
    let elapsed = 0;
    let dials = 1;
    while ((elapsed += transportRetryDelay(dials)) < 300_000) dials++;
    expect(dials).toBe(65);
  });
});

describe("resubscribing", () => {
  it("reopens a failed or ended stream and reports the connection state", async () => {
    const monitor = createConnectionMonitor();
    const abort = new AbortController();
    const closed = new Error("socket closed");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    let opens = 0;
    const open = async function* (): AsyncGenerator<string> {
      opens++;
      if (opens === 1) throw closed;
      yield `snapshot-${opens}`;
      if (opens === 2) return; // ends on its own: also a drop
      yield "live";
    };

    expect(monitor.get().status).toBe("connecting");
    const seen: string[] = [];
    const states = new Set<string>();
    monitor.subscribe(() => states.add(monitor.get().status));
    const consume = (async () => {
      for await (const value of resubscribing(open, monitor, abort.signal, { baseMs: 1 })) {
        seen.push(value);
        if (seen.length === 3) abort.abort();
      }
    })();

    await consume;
    expect(seen).toEqual(["snapshot-2", "snapshot-3", "live"]);
    expect(opens).toBe(3);
    expect(states).toEqual(new Set(["reconnecting", "open"]));
    expect(monitor.get().status).toBe("open");
    // A stream that ends on its own reconnects quietly; only the thrown error is reported.
    expect(warned).toHaveBeenCalledExactlyOnceWith("server stream dropped", closed);
  });

  it("retries immediately on retryNow instead of waiting out the backoff", async () => {
    const monitor = createConnectionMonitor();
    const abort = new AbortController();
    const down = new Error("down");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    let opens = 0;
    let readerClosed = false;
    let feed: ReturnType<typeof createChannel<number>> | undefined;
    const open = async function* (signal: AbortSignal): AsyncGenerator<number> {
      opens++;
      if (opens === 1) throw down;
      feed = createChannel<number>(signal);
      feed.push(opens);
      try {
        yield* feed;
      } finally {
        readerClosed = true;
      }
    };

    const seen: number[] = [];
    const consume = (async () => {
      for await (const value of resubscribing(open, monitor, abort.signal, { baseMs: 60_000 })) {
        seen.push(value);
      }
    })();

    try {
      await waitFor(() => monitor.get().status === "reconnecting", "reconnecting");
      expect(monitor.get()).toMatchObject({ attempt: 1 });
      monitor.retryNow();
      await waitFor(() => seen.length === 1, "reopened");
      expect(monitor.get().status).toBe("open");
      abort.abort();
      await consume;
      expect(readerClosed).toBe(true);
      expect(feed?.closed).toBe(true);
      expect(opens).toBe(2);
      expect(seen).toEqual([2]);
      expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
      expect(warned).toHaveBeenCalledExactlyOnceWith("server stream dropped", down);
    } finally {
      abort.abort();
      try {
        await consume;
      } finally {
        warned.mockRestore();
      }
    }
  });

  it("ends on an error `final` accepts, rethrowing it without reporting a drop", async () => {
    const monitor = createConnectionMonitor();
    const abort = new AbortController();
    const gone = Object.assign(new Error("gone"), { _tag: "ThreadNotFound" });
    const closed = new Error("socket closed");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warned.mockRestore());
    let opens = 0;
    const open = async function* (): AsyncGenerator<string> {
      opens++;
      if (opens === 1) throw closed;
      yield "snapshot";
      throw gone;
    };

    const seen: string[] = [];
    const states: string[] = [];
    monitor.subscribe(() => states.push(monitor.get().status));
    const consume = (async () => {
      const options = { baseMs: 1, final: (error: unknown) => error === gone };
      for await (const value of resubscribing(open, monitor, abort.signal, options)) {
        seen.push(value);
      }
    })();

    await expect(consume).rejects.toBe(gone);
    expect(seen).toEqual(["snapshot"]);
    expect(opens).toBe(2);
    expect(states).toEqual(["reconnecting", "open"]);
    expect(warned).toHaveBeenCalledExactlyOnceWith("server stream dropped", closed);
  });
});

const Events = RpcGroup.make(Rpc.make("events", { success: Schema.String, stream: true }));

/** A server that can stop answering frames and upgrade handshakes without closing its sockets. */
class StallSocket implements Socket.WebSocketLike {
  readyState: number;
  readonly listeners = new Map<string, Set<(event: Socket.WebSocketEvent) => void>>();
  readonly pending: (string | Uint8Array<ArrayBuffer>)[] = [];
  readonly number: number;
  pongDelayMs = 0;
  requests = 0;
  readonly answering: () => boolean;

  constructor(number: number, answering: () => boolean) {
    this.number = number;
    this.answering = answering;
    this.readyState = answering() ? 1 : 0;
  }

  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Socket.WebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(code = 1000) {
    this.readyState = 3;
    this.emit("close", { code });
  }

  resume() {
    if (this.readyState === 3) return;
    if (this.readyState === 0) {
      this.readyState = 1;
      this.emit("open", {});
    }
    for (const frame of this.pending.splice(0)) this.send(frame);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    if (!this.answering()) {
      this.pending.push(data);
      return;
    }
    const frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as {
      _tag: string;
      id: string;
    };
    if (frame._tag === "Ping") {
      const pong = () => this.emit("message", { data: JSON.stringify({ _tag: "Pong" }) });
      if (this.pongDelayMs === 0) pong();
      else setTimeout(pong, this.pongDelayMs);
    }
    if (frame._tag === "Request") {
      this.requests++;
      this.emit("message", {
        data: JSON.stringify({ _tag: "Chunk", requestId: frame.id, values: [String(this.number)] }),
      });
    }
  }
}

async function stalledServer(feeds = 1) {
  let answering = true;
  const sockets: StallSocket[] = [];
  const connection = createConnectionMonitor();
  const socket = Socket.layerWebSocket("ws://test/ws").pipe(
    Layer.provide(
      Layer.succeed(Socket.WebSocketConstructor)(() => {
        const ws = new StallSocket(sockets.length + 1, () => answering);
        sockets.push(ws);
        return ws;
      }),
    ),
  );
  // `resubscribing` warns once per feed per drop; the tests below assert those reports.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(rpcProtocolLayer(socket, connection), scope),
  );
  const client = await Effect.runPromise(
    RpcClient.make(Events).pipe(
      Effect.provideContext(context),
      Effect.provideService(Scope.Scope, scope),
    ),
  );
  const abort = new AbortController();
  const seenByFeed = Array.from({ length: feeds }, () => [] as string[]);
  const seen = seenByFeed[0]!;
  const consume = Promise.all(
    seenByFeed.map(async (values) => {
      for await (const value of resubscribing(
        (signal) => iterate(client.events(), signal),
        connection,
        abort.signal,
        { random: () => 0.5 },
      )) {
        values.push(value);
      }
    }),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toEqual(["1"]);
  return {
    connection,
    sockets,
    seen,
    seenByFeed,
    /** The reason tag of each reported drop, in order. */
    drops: () =>
      warn.mock.calls.map(([message, error]) => {
        expect(message).toBe("server stream dropped");
        return (error as { reason: { _tag: string } }).reason._tag;
      }),
    stall: () => {
      answering = false;
    },
    resume: () => {
      answering = true;
      for (const ws of sockets) ws.resume();
    },
    close: async () => {
      try {
        abort.abort();
        await consume;
        await Effect.runPromise(Scope.close(scope, Exit.void));
      } finally {
        warn.mockRestore();
      }
    },
  };
}

describe("RPC transport recovery", () => {
  it("a late Pong does not resubscribe feeds on an open socket", async () => {
    vi.useFakeTimers();
    const server = await stalledServer(2);
    try {
      const states: string[] = [];
      server.connection.subscribe(() => states.push(server.connection.get().status));
      const socket = server.sockets[0]!;
      socket.pongDelayMs = 4900;
      // Ping at 5 s, Pong just before the next check at 10 s, across three heartbeat cycles.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(socket.readyState).toBe(1);
      expect(server.sockets).toHaveLength(1);
      expect(socket.requests).toBe(2);
      expect(server.seenByFeed).toEqual([["1"], ["1"]]);
      expect(states).toEqual([]);
      expect(server.drops()).toEqual([]);
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });

  it.each([4700, 5000])("keeps feeds open through a %i ms event-loop stall", async (stallMs) => {
    vi.useFakeTimers();
    const server = await stalledServer();
    try {
      const states: string[] = [];
      server.connection.subscribe(() => states.push(server.connection.get().status));
      await vi.advanceTimersByTimeAsync(4998);
      server.stall();
      await vi.advanceTimersByTimeAsync(stallMs);
      server.resume();
      await vi.advanceTimersByTimeAsync(5001 - stallMs);
      expect(server.sockets).toHaveLength(1);
      expect(server.connection.get().status).toBe("open");
      expect(states).toEqual([]);
      expect(server.drops()).toEqual([]);
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });

  it("reports a silent server within 10 s and restores feeds within 500 ms of its return", async () => {
    vi.useFakeTimers();
    const server = await stalledServer();
    try {
      await vi.advanceTimersByTimeAsync(4998);
      server.stall();
      await vi.advanceTimersByTimeAsync(5010);
      expect(server.connection.get().status).toBe("reconnecting");
      await vi.advanceTimersByTimeAsync(100);
      server.resume();
      await vi.advanceTimersByTimeAsync(500);
      expect(server.seen).toEqual(["1", "2"]);
      expect(server.connection.get().status).toBe("open");
      expect(server.drops()).toEqual(["SocketReadError"]);
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });

  it("wakes every feed after repeated failures instead of inheriting either backoff", async () => {
    vi.useFakeTimers();
    const server = await stalledServer(2);
    try {
      for (let i = 0; i < 9; i++) {
        server.sockets.at(-1)!.close(1006);
        await vi.advanceTimersByTimeAsync(500);
        expect(server.connection.get().status).toBe("open");
      }
      server.stall();
      server.sockets.at(-1)!.close(1006);
      // Failed upgrade handshakes take up to 10 s; feed retries meanwhile reach the 8 s step.
      await vi.advanceTimersByTimeAsync(12_000);
      expect(server.connection.get()).toMatchObject({ status: "reconnecting", attempt: 5 });
      server.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(server.seen).toHaveLength(11);
      expect(server.seenByFeed[1]).toHaveLength(11);
      expect(server.connection.get().status).toBe("open");
      // Both feeds drop on each of the ten closes and on each of the four refused handshakes.
      expect(server.drops()).toEqual(Array(28).fill("SocketCloseError"));
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });

  it("caps retries during a long refusal and resets only after feeds are healthy", async () => {
    vi.useFakeTimers();
    const server = await stalledServer(2);
    try {
      const refuse = async (delay: number) => {
        server.sockets.at(-1)!.close(1006);
        const previous = server.sockets.length;
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(server.sockets).toHaveLength(previous);
        await vi.advanceTimersByTimeAsync(1);
        expect(server.sockets).toHaveLength(previous + 1);
      };
      server.stall();
      for (const delay of [500, 500, 500, 1000, 2000, 4000, 5000, 5000, 5000]) {
        await refuse(delay);
      }
      expect(server.connection.get().status).toBe("reconnecting");
      // An upgrade without a feed response must not reset the capped retry counter.
      server.sockets.at(-1)!.readyState = 1;
      server.sockets.at(-1)!.emit("open", {});
      await vi.advanceTimersByTimeAsync(1);
      await refuse(5000);
      server.resume();
      await vi.advanceTimersByTimeAsync(1);
      expect(server.connection.get().status).toBe("open");
      // A new failure after both feeds answered starts a fresh quick retry wave.
      await refuse(500);
      expect(server.connection.get().status).toBe("open");
      // Both feeds drop on each of the eight closes.
      expect(server.drops()).toEqual(Array(16).fill("SocketCloseError"));
    } finally {
      await server.close();
      vi.useRealTimers();
    }
  });
});

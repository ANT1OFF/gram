import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerMachineRelayMessage } from "@gram/contracts";

import type { HostedDevice } from "./hosted-device.ts";
import {
  answerWorkerMachines,
  makeWorkerMachineRelays,
  type RelaySocket,
} from "./serve-machines.ts";

const ORIGIN = "https://hosted.example.test";
const NAME = "worker-0123456789";
const HEADERS = {
  "x-gram-host-id": "m-0123456789abcdef01234567",
  "x-gram-host-time": "1",
  "x-gram-host-nonce": "0".repeat(32),
  "x-gram-host-signature": "c2lnbmVk",
};

/** A relay socket the test drives: what the app sent on it, and the events it fires. */
const fakeSocket = () => {
  const listeners = new Map<string, Array<(event: never) => void>>();
  const sent: Array<string | Uint8Array> = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const fire = (type: string, event: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(event as never);
  };
  const socket: RelaySocket = {
    binaryType: "blob",
    readyState: 1,
    send: (data) => sent.push(data),
    close: (code, reason) => {
      closed.push({
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      });
      fire("close", { code, reason });
    },
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  return { socket, sent, closed, fire };
};

const deviceFor = (dials: Array<{ origin: string; name: string }>) =>
  ({
    workerMachineRelayDial: async (origin: string, name: string) => {
      dials.push({ origin, name });
      return {
        ok: true,
        url: `wss://hosted.example.test/worker-machines/connect?name=${name}`,
        headers: { authorization: "DPoP synthetic" },
      };
    },
    workerMachineServer: () => ({ ok: true, server: { origin: ORIGIN, server: "Example" } }),
    workerMachineCall: async () => ({ ok: true, status: 202, body: { name: NAME } }),
  }) as unknown as HostedDevice;

afterEach(() => {
  vi.useRealTimers();
});

describe("a worker machine's relay", () => {
  it("passes the host's dial and its frames to the server, the server's back, and dials again when it ends", async () => {
    vi.useFakeTimers();
    const dials: Array<{ origin: string; name: string }> = [];
    const opened: Array<
      { url: string; headers: Record<string, string> } & ReturnType<typeof fakeSocket>
    > = [];
    const posted: WorkerMachineRelayMessage[] = [];
    const relays = makeWorkerMachineRelays({
      device: () => deviceFor(dials),
      post: (message) => posted.push(message),
      open: (url, headers) => {
        const made = fakeSocket();
        opened.push({ url, headers, ...made });
        return made.socket;
      },
    });
    relays.relay(ORIGIN, NAME);
    await vi.advanceTimersByTimeAsync(0);
    expect(dials).toEqual([{ origin: ORIGIN, name: NAME }]);
    const first = opened[0]!;
    expect(first.headers).toEqual({ authorization: "DPoP synthetic" });
    expect(first.socket.binaryType).toBe("arraybuffer");
    first.fire("open", {});
    first.fire("message", { data: JSON.stringify({ dial: { headers: HEADERS } }) });
    expect(posted).toEqual([
      {
        type: "machines.relay.dial",
        conn: expect.any(String),
        origin: ORIGIN,
        name: NAME,
        headers: HEADERS,
      },
    ]);
    const conn = (posted[0] as { conn: string }).conn;
    const bytes = new Uint8Array([1, 2, 3]);
    first.fire("message", { data: bytes.buffer });
    expect(posted[1]).toEqual({ type: "machines.relay.frame", conn, data: bytes });
    relays.fromServer({ type: "machines.relay.frame", conn, data: "hello" });
    expect(first.sent).toEqual(["hello"]);
    // The server ends it: closed with its code, said once, and dialled again after a wait.
    relays.fromServer({ type: "machines.relay.end", conn, code: 4401, reason: "unauthorized" });
    expect(first.closed).toEqual([{ code: 4401, reason: "unauthorized" }]);
    expect(posted.filter((each) => each.type === "machines.relay.end")).toEqual([
      { type: "machines.relay.end", conn },
    ]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dials).toHaveLength(2);
    // Once the server stops wanting it, it is closed and never dialled again.
    relays.unrelay(NAME);
    expect(opened[1]!.closed).toEqual([{ code: 1000, reason: "no longer relayed" }]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dials).toHaveLength(2);
  });

  it("closes a relay whose first frame isn't a host's dial, and passes nothing from it", async () => {
    vi.useFakeTimers();
    const posted: WorkerMachineRelayMessage[] = [];
    const opened: Array<ReturnType<typeof fakeSocket>> = [];
    const relays = makeWorkerMachineRelays({
      device: () => deviceFor([]),
      post: (message) => posted.push(message),
      open: () => {
        const made = fakeSocket();
        opened.push(made);
        return made.socket;
      },
    });
    relays.relay(ORIGIN, NAME);
    await vi.advanceTimersByTimeAsync(0);
    opened[0]!.fire("message", {
      data: JSON.stringify({ dial: { headers: { authorization: "x" } } }),
    });
    expect(opened[0]!.closed).toEqual([
      { code: 4400, reason: "the relay's first frame isn't a dial" },
    ]);
    expect(posted).toEqual([]);
    relays.close();
  });
});

describe("the server's worker machine requests", () => {
  it("answers which server, and makes a call only of a known kind", async () => {
    const relays = makeWorkerMachineRelays({ device: () => undefined, post: () => undefined });
    const device = deviceFor([]);
    expect(
      await answerWorkerMachines(
        { type: "machines.request", id: "1", op: "server" },
        device,
        relays,
      ),
    ).toEqual({
      type: "machines.response",
      id: "1",
      result: { ok: true, server: { origin: ORIGIN, server: "Example" } },
    });
    expect(
      await answerWorkerMachines(
        {
          type: "machines.request",
          id: "2",
          op: "call",
          origin: ORIGIN,
          call: "start",
          body: { name: NAME },
        },
        device,
        relays,
      ),
    ).toMatchObject({ result: { ok: true, status: 202 } });
    expect(
      await answerWorkerMachines(
        {
          type: "machines.request",
          id: "3",
          op: "call",
          origin: ORIGIN,
          call: "delete-everything",
          body: {},
        },
        device,
        relays,
      ),
    ).toMatchObject({ result: { ok: false } });
    expect(
      await answerWorkerMachines(
        { type: "machines.request", id: "4", op: "server" },
        undefined,
        relays,
      ),
    ).toMatchObject({ result: { ok: false, why: "Hosted features are off in this app." } });
  });
});

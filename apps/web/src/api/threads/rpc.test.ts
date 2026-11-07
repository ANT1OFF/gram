import type { ThreadId, QueueItemId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { SocketReadError } from "effect/socket/Socket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectionMonitor } from "../connection";
import type { RpcContext } from "../rpc-client";
import { threadsRpc } from "./rpc";

const T = "thread" as ThreadId;
const socketDrop = () =>
  new RpcClientError({ reason: new SocketReadError({ cause: new Error("synthetic drop") }) });
afterEach(() => vi.useRealTimers());

describe("message identities", () => {
  for (const [method, tag] of [
    ["send", "thread.send"],
    ["steer", "thread.steer"],
    ["queueSteer", "thread.queue.steer"],
  ] as const) {
    it(`keeps ${method}'s id through a lost reply, and gives a new action a new id`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
      const received: unknown[] = [];
      let lost = true;
      const request = vi.fn((payload: unknown) =>
        Effect.suspend(() => {
          received.push(payload);
          if (lost) {
            lost = false;
            return Effect.fail(socketDrop());
          }
          return Effect.succeed({ queued: false });
        }),
      );
      const api = threadsRpc({
        client: { [tag]: request },
        connection: createConnectionMonitor(),
      } as unknown as RpcContext);
      const send = () =>
        method === "queueSteer"
          ? api.queueSteer(T, "q1" as QueueItemId)
          : api[method](T, { text: "same words" });
      const first = send();
      await vi.advanceTimersByTimeAsync(500);
      await first;
      expect(received).toHaveLength(2);
      expect(received[0]).toEqual(received[1]);
      expect(received[0]).toHaveProperty("clientMessageId", expect.any(String));
      await send();
      expect(received[2]).not.toEqual(received[0]);
    });
  }
  it("does not retry a server refusal", async () => {
    const action = vi.fn(() => Effect.fail({ _tag: "InvalidState", message: "no turn" }));
    const api = threadsRpc({
      client: { "thread.steer": action },
      connection: createConnectionMonitor(),
    } as unknown as RpcContext);
    await expect(api.steer(T, { text: "once" })).rejects.toMatchObject({ _tag: "InvalidState" });
    expect(action).toHaveBeenCalledTimes(1);
  });
});

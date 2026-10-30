import type { TerminalEvent, TerminalId } from "@gram/contracts";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";

import { createConnectionMonitor } from "../connection";
import type { RpcContext } from "../rpc-client";
import { terminalRpc } from "./rpc";

const ID = "term-1" as TerminalId;

/** A client whose `terminal.subscribe` answers each call with the next of `streams`. */
const feedOf = (streams: Stream.Stream<TerminalEvent, unknown>[]) => {
  const subscribe = vi.fn(() => streams.shift() ?? Stream.never);
  const connection = createConnectionMonitor();
  const api = terminalRpc({
    client: { "terminal.subscribe": subscribe },
    connection,
  } as unknown as RpcContext);
  return { api, subscribe, connection };
};

const collect = async (events: AsyncIterable<TerminalEvent>) => {
  const seen: TerminalEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
};

describe("terminalFeed", () => {
  it("reopens after a dropped connection, replaying, and ends at exit without reopening", async () => {
    const { api, subscribe, connection } = feedOf([
      Stream.concat(
        Stream.fromIterable<TerminalEvent>([{ type: "replay", data: "$ " }]),
        Stream.fail(new Error("socket closed")),
      ),
      Stream.fromIterable<TerminalEvent>([
        { type: "replay", data: "$ ls\r\n" },
        { type: "exit", code: 0 },
      ]),
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const abort = new AbortController();
    const feed = collect(api.terminalFeed(ID, abort.signal));
    // Past the backoff, at once.
    await vi.waitFor(() => {
      connection.retryNow();
      expect(subscribe).toHaveBeenCalledTimes(2);
    });

    expect(await feed).toEqual([
      { type: "replay", data: "$ " },
      { type: "replay", data: "$ ls\r\n" },
      { type: "exit", code: 0 },
    ]);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(connection.get().status).toBe("open");
  });

  it("hands a terminal the server no longer has to the view instead of retrying", async () => {
    const gone = Object.assign(new Error("terminal"), { _tag: "NotFound" });
    const { api, subscribe } = feedOf([Stream.fail(gone)]);
    await expect(collect(api.terminalFeed(ID, new AbortController().signal))).rejects.toBe(gone);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});

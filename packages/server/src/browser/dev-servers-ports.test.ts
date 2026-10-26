import { EventEmitter } from "node:events";
import { connect, Socket } from "node:net";
import type * as Net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isFree } from "./dev-servers.ts";

vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof Net>()),
  connect: vi.fn(),
  // The IPv4 bind succeeds; these cases exercise the IPv6 connection probe's result.
  createServer: () => {
    const server = new EventEmitter();
    return Object.assign(server, {
      listen: (_options: unknown, done: () => void) => queueMicrotask(done),
      close: (done: () => void) => queueMicrotask(done),
    });
  },
}));

afterEach(() => vi.clearAllMocks());

describe("the IPv6 port probe", () => {
  it.each([
    { name: "a self-connection", localPort: 53346, localAddress: "::1", free: true },
    { name: "a listener", localPort: 53347, localAddress: "::1", free: false },
    {
      name: "the same port at another address",
      localPort: 53346,
      localAddress: "::2",
      free: false,
    },
  ])("distinguishes $name", async ({ localPort, localAddress, free }) => {
    const socket = new Socket();
    Object.defineProperties(socket, {
      localPort: { value: localPort },
      localAddress: { value: localAddress },
      remotePort: { value: 53346 },
      remoteAddress: { value: "::1" },
    });
    vi.mocked(connect).mockReturnValue(socket);
    const result = isFree(53346);
    // Deliver the connection after the bind/close callbacks and listener registration.
    setImmediate(() => socket.emit("connect"));
    expect(await result).toBe(free);
    expect(connect).toHaveBeenCalledWith({ port: 53346, host: "::1" });
    expect(socket.destroyed).toBe(true);
  });
});

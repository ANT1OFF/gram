import { connect as netConnect, type Socket } from "node:net";

import {
  HostFailed,
  LOOPBACK_CHUNK_BYTES,
  type LoopbackEvent,
  type LoopbackHost,
} from "@gram/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** The most tunnels a host keeps open at once: a page opens a handful per origin. */
export const LOOPBACK_TUNNELS_MAX = 256;

export interface HostLoopback {
  readonly open: (
    tunnelId: string,
    host: LoopbackHost,
    port: number,
  ) => Stream.Stream<LoopbackEvent, HostFailed>;
  readonly send: (tunnelId: string, data: string) => Effect.Effect<void, HostFailed>;
  readonly end: (tunnelId: string) => Effect.Effect<void>;
}

type Connect = (options: { host: string; port: number }) => Socket;

const addressesOf = (host: LoopbackHost): ReadonlyArray<string> =>
  host === "localhost" ? ["127.0.0.1", "::1"] : [host];

const connectFirst = (
  connect: Connect,
  addresses: ReadonlyArray<string>,
  port: number,
): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const attempt = (index: number) => {
      const socket = connect({ host: addresses[index]!, port });
      const failed = (error: Error) => {
        socket.destroy();
        if (index + 1 < addresses.length) attempt(index + 1);
        else reject(error);
      };
      socket.once("error", failed);
      socket.once("connect", () => {
        socket.off("error", failed);
        resolve(socket);
      });
    };
    attempt(0);
  });

const encoded = (chunk: Buffer): ReadonlyArray<string> => {
  const pieces: string[] = [];
  for (let at = 0; at < chunk.length; at += LOOPBACK_CHUNK_BYTES)
    pieces.push(chunk.subarray(at, at + LOOPBACK_CHUNK_BYTES).toString("base64"));
  return pieces;
};

export const hostLoopback = (connect: Connect = netConnect): HostLoopback => {
  const open = new Map<string, Socket>();
  return {
    open: (tunnelId, host, port) =>
      Stream.callback<LoopbackEvent, HostFailed>((queue) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              if (open.has(tunnelId)) throw new Error(`Tunnel ${tunnelId} is already open.`);
              if (open.size >= LOOPBACK_TUNNELS_MAX)
                throw new Error("This machine has as many loopback tunnels open as it keeps.");
              const socket = await connectFirst(connect, addressesOf(host), port);
              open.set(tunnelId, socket);
              Queue.offerUnsafe(queue, { type: "connected" });
              socket.on("data", (chunk: Buffer) => {
                for (const data of encoded(chunk)) Queue.offerUnsafe(queue, { type: "data", data });
              });
              socket.once("end", () => Queue.endUnsafe(queue));
              socket.once("close", () => Queue.endUnsafe(queue));
              socket.once("error", () => Queue.endUnsafe(queue));
              return socket;
            },
            catch: (error) =>
              new HostFailed({
                message: `Nothing answered on ${host} port ${port} on this machine: ${error instanceof Error ? error.message : String(error)}`,
              }),
          }),
          (socket) =>
            Effect.sync(() => {
              if (open.get(tunnelId) === socket) open.delete(tunnelId);
              socket.destroy();
            }),
        ).pipe(
          Effect.catch((error) => Queue.fail(queue, error)),
          Effect.asVoid,
        ),
      ),
    send: (tunnelId, data) =>
      Effect.suspend((): Effect.Effect<void, HostFailed> => {
        const socket = open.get(tunnelId);
        if (socket === undefined || socket.destroyed)
          return Effect.fail(new HostFailed({ message: `Tunnel ${tunnelId} isn't open.` }));
        const bytes = Buffer.from(data, "base64");
        if (bytes.length > LOOPBACK_CHUNK_BYTES)
          return Effect.fail(
            new HostFailed({ message: "That chunk is larger than a tunnel takes." }),
          );
        return Effect.callback<void, HostFailed>((resume) => {
          socket.write(bytes, (error) =>
            resume(
              error == null
                ? Effect.void
                : Effect.fail(new HostFailed({ message: `The tunnel closed: ${error.message}` })),
            ),
          );
        });
      }),
    end: (tunnelId) =>
      Effect.sync(() => {
        open.get(tunnelId)?.end();
      }),
  };
};

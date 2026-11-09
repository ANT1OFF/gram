import * as Effect from "effect/Effect";
import type { Socket } from "../platform/unstable.ts";

/**
 * `socket` with its end reported: once it fails to open or a read fails (the other side closed,
 * refused the upgrade, or the stream broke) `ended` runs. The RPC layers over a socket keep
 * waiting on one that went, so whoever owns it ends them on this.
 */
export const watchedSocket = (
  socket: Socket.Socket,
  ended: Effect.Effect<void>,
  /** Runs on each read that brings data: the other side is there and talking. */
  received: Effect.Effect<void> = Effect.void,
): Socket.Socket => ({
  ...socket,
  reader: socket.reader.pipe(
    Effect.tapError(() => ended),
    Effect.map((reader) => ({
      ...reader,
      pull: reader.pull.pipe(
        Effect.tapError(() => ended),
        Effect.tap(() => received),
      ),
    })),
  ),
});

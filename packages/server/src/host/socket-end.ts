import * as Effect from "effect/Effect";
import type { Socket } from "../platform/unstable.ts";

/**
 * `socket` with its end reported: once it fails to open or a read fails (the other side closed,
 * refused the upgrade, or the stream broke) `ended` runs, given the error when it takes one. The
 * RPC layers over a socket keep waiting on one that went, so whoever owns it ends them on this.
 */
export const watchedSocket = (
  socket: Socket.Socket,
  ended: Effect.Effect<void> | ((error: Socket.SocketError) => Effect.Effect<void>),
  /** Runs on each read that brings data: the other side is there and talking. */
  received: Effect.Effect<void> = Effect.void,
): Socket.Socket => {
  const end = (error: Socket.SocketError) => (typeof ended === "function" ? ended(error) : ended);
  return {
    ...socket,
    reader: socket.reader.pipe(
      Effect.tapError(end),
      Effect.map((reader) => ({
        ...reader,
        pull: reader.pull.pipe(
          Effect.tapError(end),
          Effect.tap(() => received),
        ),
      })),
    ),
  };
};

/**
 * Why a socket ended, in a few words for a log: a close with its code and reason, or a failure
 * with what the platform said. Never the request or its headers.
 */
export const socketEndText = (error: Socket.SocketError): string => {
  const reason = error.reason;
  if (reason._tag === "SocketCloseError") return `closed (${reason.message})`;
  const cause = "cause" in reason ? reason.cause : undefined;
  const detail = cause instanceof Error ? cause.message : undefined;
  return detail === undefined || detail === "" ? reason.message : `${reason.message}: ${detail}`;
};

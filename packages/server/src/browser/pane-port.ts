// The server's door to the native shell's Preview pane over Electron's utilityProcess
// parentPort. The shell owns every browsing rule; this module carries requests and
// stops waiting when a request times out or its caller is interrupted.

import { randomUUID } from "node:crypto";

import {
  PANE_COMMAND_TIMEOUT_MS,
  type PaneCancelMessage,
  type PaneRequest,
  type PaneRequestMessage,
  type PaneResponseMessage,
  type PaneResult,
} from "@gram/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface PanePortShape {
  /** Sends one request to the shell; a missing shell or one that doesn't answer is a failed result. */
  send(request: PaneRequest): Effect.Effect<PaneResult>;
}

export class PanePort extends Context.Service<PanePort, PanePortShape>()("@gram/server/PanePort") {
  /** Native bridge when Electron supplied a parent port; otherwise there is no pane. */
  static readonly layer: Layer.Layer<PanePort> = Layer.sync(PanePort, () => {
    const port = (process as { parentPort?: PaneMessagePort }).parentPort;
    return port === undefined ? NO_PANE : bridgePane(port);
  });
}

const NO_PANE: PanePortShape = {
  send: () =>
    Effect.succeed({
      ok: false,
      code: "noPane",
      message:
        "There is no Preview pane here: agents browse only in the Gram app, not in a browser tab.",
    }),
};

const timedOut: PaneResult = {
  ok: false,
  code: "failed",
  message: "The Preview pane didn't answer in time.",
};

// ---------------------------------------------------------------------------------------------
// Desktop: Electron main, over the utilityProcess port.

/** Electron's `process.parentPort` as the server sees it. */
export interface PaneMessagePort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
}

const isPaneResponse = (message: unknown): message is PaneResponseMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "pane.response" &&
  typeof (message as { id?: unknown }).id === "string" &&
  typeof (message as { result?: unknown }).result === "object";

/** Pane commands over `port`, each answered by id or failed after `timeoutMs`. */
export const bridgePane = (
  port: PaneMessagePort,
  timeoutMs: number = PANE_COMMAND_TIMEOUT_MS,
): PanePortShape => {
  const pending = new Map<string, (result: PaneResult) => void>();
  port.on("message", ({ data }) => {
    if (!isPaneResponse(data)) return;
    pending.get(data.id)?.(data.result);
  });
  return {
    send: (request) =>
      Effect.callback<PaneResult>((resume) => {
        const id = randomUUID();
        const cancel = () => {
          if (!pending.delete(id)) return;
          const message: PaneCancelMessage = { type: "pane.cancel", id };
          port.postMessage(message);
        };
        const timer = setTimeout(() => {
          cancel();
          settle(timedOut);
        }, timeoutMs);
        function settle(result: PaneResult) {
          clearTimeout(timer);
          pending.delete(id);
          resume(Effect.succeed(result));
        }
        pending.set(id, settle);
        const message: PaneRequestMessage = { type: "pane.request", id, request };
        port.postMessage(message);
        return Effect.sync(() => {
          clearTimeout(timer);
          cancel();
        });
      }),
  };
};

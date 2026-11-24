import type { SPEECH_PORT_MESSAGE } from "@gram/contracts";

import type { SpeechSessionKind } from "../../speech-process/protocol.ts";

const PORT_MESSAGE: typeof SPEECH_PORT_MESSAGE = "gram:speech-port";

/** The page's window, as the relay posts to it. */
export interface RelayWindow {
  postMessage(message: unknown, targetOrigin: string, transfer: MessagePort[]): void;
  readonly location: { readonly origin: string };
}

const lastMessage = (_kind: SpeechSessionKind, data: unknown): boolean => {
  if (typeof data !== "object" || data === null || !("type" in data)) return false;
  if (data.type === "error") return true;
  return data.type === "final" && "reason" in data && data.reason === "stop";
};

const crashOf = (_kind: SpeechSessionKind, message: string) => ({
  type: "error",
  code: "crashed",
  message,
});

/**
 * Gives the page a port of its own for each session and relays it to the speech process's. The
 * relay is what lets the shell speak on a session's port itself: a port can't cross
 * `contextBridge`, so the page's is posted to the window, and once it has gone there the speech
 * process dying would otherwise reach the page as silence. Relaying also copies every frame, so a
 * buffer the page transferred never reaches `MessagePortMain`, which receives it as `null`.
 */
export function createSpeechRelay(window: RelayWindow) {
  const relays = new Map<
    string,
    { readonly page: MessagePort; readonly close: () => void; readonly kind: SpeechSessionKind }
  >();

  return {
    /** Starts relaying `upstream` (the speech process's port) and posts the page its end. */
    attach(sessionId: string, upstream: MessagePort, kind: SpeechSessionKind = "local") {
      relays.get(sessionId)?.close();
      const { port1: page, port2: pageEnd } = new MessageChannel();
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        relays.delete(sessionId);
        page.close();
        upstream.close();
      };
      upstream.addEventListener("message", (event) => {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort
        page.postMessage(event.data);
        if (lastMessage(kind, event.data)) close();
      });
      page.addEventListener("message", (event) => {
        const data: unknown = event.data;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort
        upstream.postMessage(data);
        if (typeof data === "object" && data !== null && "type" in data && data.type === "cancel")
          close();
      });
      upstream.addEventListener("close", () => {
        if (!open) return;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort
        page.postMessage(crashOf(kind, "the speech process stopped"));
        close();
      });
      page.addEventListener("close", close);
      upstream.start();
      page.start();
      relays.set(sessionId, { page, close, kind });
      window.postMessage({ type: PORT_MESSAGE, sessionId }, window.location.origin, [pageEnd]);
    },

    /** The speech process died under `sessionId`: tell the page on its port and close it. */
    crashed(sessionId: string, message: string) {
      const relay = relays.get(sessionId);
      if (relay === undefined) return;
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- MessagePort
      relay.page.postMessage(crashOf(relay.kind, message));
      relay.close();
    },
  };
}

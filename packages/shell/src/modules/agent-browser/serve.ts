// Answering the server's pane messages, shared by the desktop shell and the headless browser host.

import {
  paneRequestMessage,
  paneCancelMessage,
  type PaneResponseMessage,
  type PaneResult,
} from "@gram/contracts/link-trust";

import type { AgentPanes } from "./pane.ts";

/**
 * Answers the server's `pane.request` through `panes`, ignoring every other message; with
 * no panes yet, early in launch, the answer is that there is no pane.
 */
export function servePaneMessage(
  message: unknown,
  panes: AgentPanes | undefined,
  reply: (response: PaneResponseMessage) => void,
): void {
  const cancellation = paneCancelMessage(message);
  if (cancellation !== undefined) {
    panes?.cancel(cancellation.id);
    return;
  }
  const request = paneRequestMessage(message);
  if (request === undefined) return;
  const answer: Promise<PaneResult> =
    panes === undefined
      ? Promise.resolve({ ok: false, code: "noPane", message: "The Preview pane isn't ready yet." })
      : panes.serve(request.request, request.id);
  void answer.then((result) => reply({ type: "pane.response", id: request.id, result }));
}

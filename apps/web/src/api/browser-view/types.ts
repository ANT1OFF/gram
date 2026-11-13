import type { BrowserViewEvent, BrowserViewInput, ThreadId, ViewControl } from "@gram/contracts";

/** What the feed yields: the server's events, and `dropped` each time the connection to it is lost. */
export type BrowserViewFeedEvent = BrowserViewEvent | { readonly type: "dropped" };

/**
 * `browserView.*`: the page a thread's agent drives in the server's own browser, for a window with
 * no Preview pane of its own (a browser tab).
 */
export interface BrowserViewApi {
  /**
   * The thread's page now, then each change and frame, reopened after a dropped connection. Throws
   * when the server runs no browser of its own, or is older than this.
   */
  browserViewFeed(threadId: ThreadId, signal: AbortSignal): AsyncIterable<BrowserViewFeedEvent>;
  browserViewInput(threadId: ThreadId, inputs: readonly BrowserViewInput[]): Promise<void>;
  browserViewControl(threadId: ThreadId, op: ViewControl): Promise<void>;
}

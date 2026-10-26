import type { ThreadId, WindowPlacement, WindowPlacements } from "@gram/contracts";

import { createChannel } from "./channel";

type Message =
  | { readonly type: "hello" }
  | { readonly type: "placement"; readonly placement: WindowPlacement }
  | { readonly type: "bye"; readonly windowId: string };

const CHANNEL = "gram.mock.windows";

/**
 * `windows.watch` / `windows.report` for MockApi. Tabs of the mock app share placements over a
 * BroadcastChannel, standing in for the server that real windows share.
 */
export class MockWindows {
  readonly #placements = new Map<string, WindowPlacement>();
  readonly #listeners = new Set<(placements: WindowPlacements) => void>();
  #self: WindowPlacement | undefined;
  #channel: BroadcastChannel | undefined;

  #snapshot(): WindowPlacements {
    return { windows: [...this.#placements.values()] };
  }

  #changed() {
    const snapshot = this.#snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #post(message: Message) {
    this.#channel?.postMessage(message);
  }

  #connect() {
    if (this.#channel || typeof BroadcastChannel === "undefined") return;
    this.#channel = new BroadcastChannel(CHANNEL);
    this.#channel.addEventListener("message", (event: MessageEvent<Message>) => {
      const message = event.data;
      if (message.type === "hello") {
        if (this.#self) this.#post({ type: "placement", placement: this.#self });
        return;
      }
      if (message.type === "placement")
        this.#placements.set(message.placement.windowId, message.placement);
      else this.#placements.delete(message.windowId);
      this.#changed();
    });
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        if (!this.#self) return;
        this.#post({ type: "bye", windowId: this.#self.windowId });
        // A closing tab still fires `visibilitychange` and `blur` after `pagehide`, and the report
        // those trigger would re-announce this window to the others right after its goodbye.
        this.#self = undefined;
      });
    }
  }

  watch(windowId: string, name: string, signal: AbortSignal): AsyncIterable<WindowPlacements> {
    const push = (placements: WindowPlacements) => channel.push(placements);
    const channel = createChannel<WindowPlacements>(signal, () => this.#listeners.delete(push));
    this.#listeners.add(push);
    this.#self = { windowId, name, threadIds: this.#placements.get(windowId)?.threadIds ?? [] };
    this.#placements.set(windowId, this.#self);
    this.#connect();
    this.#post({ type: "placement", placement: this.#self });
    this.#post({ type: "hello" });
    this.#changed();
    return channel;
  }

  report(windowId: string, threadIds: readonly ThreadId[]) {
    if (this.#self?.windowId !== windowId) return;
    this.#self = { ...this.#self, threadIds: [...threadIds] };
    this.#placements.set(windowId, this.#self);
    this.#post({ type: "placement", placement: this.#self });
    this.#changed();
  }
}

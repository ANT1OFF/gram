import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

interface ModelPickerRequests {
  /** By thread, how many times its model picker was asked to open; each ask opens it once. */
  readonly asked: Readonly<Record<string, number>>;
}

/**
 * Asks to open one thread's model picker from outside its composer: a rate-limited turn's "Try
 * another model". Keyed by thread, so it opens the picker of the thread whose card asked, not
 * whichever pane holds focus (as `composer.model`'s shortcut would).
 */
export const useModelPickerRequests = create<ModelPickerRequests>()(() => ({ asked: {} }));

export const askModelPicker = (threadId: ThreadId): void =>
  useModelPickerRequests.setState((s) => ({
    asked: { ...s.asked, [threadId]: (s.asked[threadId] ?? 0) + 1 },
  }));

/**
 * Calls `open` on each ask for `threadId`'s model picker made from now on; returns the unsubscribe.
 * An ask from before it subscribed stays answered.
 */
export const onModelPickerAsked = (threadId: ThreadId, open: () => void): (() => void) =>
  useModelPickerRequests.subscribe((state, before) => {
    if (state.asked[threadId] !== before.asked[threadId]) open();
  });

import type { ThreadId } from "@gram/contracts";
import { create } from "zustand";

import type { Chapter } from "@/thread/parts";
import type { OutlineHistory } from "@/thread/table-of-contents";

/**
 * The Contents of the thread the title bar carries: its header's chapter list, which the bar's one
 * "…" offers as a submenu instead of a button of its own. The thread's view publishes it while its
 * header is in the bar; `jump` and `onLoadEarlier` are stable and call the view's latest.
 */
export interface TitlebarOutline extends OutlineHistory {
  readonly threadId: ThreadId;
  readonly chapters: readonly Chapter[];
  readonly jump: (messageId: string) => void;
}

export const useTitlebarOutline = create<{
  outline: TitlebarOutline | undefined;
  set(outline: TitlebarOutline | undefined): void;
}>()((set) => ({
  outline: undefined,
  set: (outline) => set({ outline }),
}));

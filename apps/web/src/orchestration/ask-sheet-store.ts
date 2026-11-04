import type { WorkspaceId } from "@gram/contracts";
import { create } from "zustand";

import type { Ask } from "./ask-model";
import { useAskStackStore } from "./ask-stack-store";
import { useFeatureSheet } from "./feature-sheet-store";

// The Asks dock is where every ask in a workspace is answered. What one key can't answer (a plan,
// an approval to read in full, several choices, a long question) opens in the ask sheet, over the
// view, with its answer row kept in sight. A jump to an ask (Needs you, a Board chip, the Board's
// band) goes through `showAsk`, which turns the dock to it and opens the sheet when it needs one.

export interface AskSheetTarget {
  readonly workspaceId: WorkspaceId;
  /** The ask's first id: a group that gains or loses a member keeps its sheet. */
  readonly id: string;
}

interface AskSheetState {
  readonly target: AskSheetTarget | undefined;
  readonly open: (target: AskSheetTarget) => void;
  readonly close: () => void;
}

export const useAskSheet = create<AskSheetState>()((set) => ({
  target: undefined,
  open: (target) => set({ target }),
  close: () => set({ target: undefined }),
}));

/** Whether an ask is answered in the sheet: every option it offers reads it in full first. */
export const answersInSheet = (ask: Pick<Ask, "options">): boolean =>
  ask.options.length > 0 &&
  ask.options.every((option) => option.action.kind === "open" || option.action.kind === "board");

/** Opens `ask` in the sheet. */
export const openAskSheet = (workspaceId: WorkspaceId, ask: Pick<Ask, "ids" | "key">) => {
  const id = ask.ids[0] ?? ask.key;
  // One sheet at a time: a feature's sheet it was opened from gives way to it.
  useFeatureSheet.getState().close(false);
  useAskSheet.getState().open({ workspaceId, id });
};

/**
 * Turns the dock to `ask`, which scrolls it into view, rings it and takes focus so its keys answer
 * it; one that needs reading in full opens in the sheet as well.
 */
export const showAsk = (workspaceId: WorkspaceId, ask: Ask) => {
  useAskStackStore.getState().focus(ask.key);
  if (answersInSheet(ask)) openAskSheet(workspaceId, ask);
};

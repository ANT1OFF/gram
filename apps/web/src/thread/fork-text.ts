import type { Thread } from "@gram/contracts";

/** "Forked from <source title>", for the pane header link and the sidebar row marker. */
export const forkedFromText = (
  from: NonNullable<Thread["forkedFrom"]>,
  sourceTitle: string | undefined,
): string =>
  from.threadId
    ? `Forked from ${sourceTitle ?? "a closed thread"}`
    : "Forked from an imported session";

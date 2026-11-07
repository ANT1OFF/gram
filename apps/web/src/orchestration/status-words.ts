import type { RailTone } from "./rail-model";
import type { WorkerGlyph } from "./workers-model";

// The few words a status says, wherever it is said: the sidebar's rows, the Board's chips, ⌘J,
// the palette and History. One word per state, so the same item never reads "Stopped" in one place
// and "Idle" in another. A wait adds what it waits on ("Waiting · checks on #142"), never a word
// of its own. No React.

/** Every state a dot can say: a worker's tone, a finished or archived worker, and a held brief. */
export type DotState = RailTone | "done" | "archived" | "held";

export const STATUS_WORDS: Readonly<Record<DotState, string>> = {
  needs: "Needs you",
  working: "Running",
  waiting: "Waiting",
  // Stalled on its own next step: at rest like idle, its row's line saying why.
  attention: "Stopped",
  error: "Failed",
  idle: "Stopped",
  merged: "Done",
  done: "Done",
  archived: "Done",
  // Held until a limit resets, or by you: a wait like any other, its reason in words.
  held: "Waiting",
};

/**
 * What a worker says between its spawn and its first turn: its brief not yet picked up (`briefed`)
 * or its session opening. Never "Stopped": nothing has run yet to stop. Its tone is working's.
 */
export const STARTING = "Starting…";

/** What a worker's status says in a line: what it waits on while it waits, else its tone's word. */
export const workerStatusWord = (
  state: DotState,
  waiting: { readonly label: string } | undefined,
): string => waiting?.label ?? STATUS_WORDS[state];

/** A ⌘J row's glyph as the dot every view draws for it. */
const GLYPH_STATE: Readonly<Record<WorkerGlyph, DotState>> = {
  working: "working",
  waiting: "waiting",
  needsYou: "needs",
  error: "error",
  idle: "idle",
  merged: "merged",
  delivered: "done",
  archived: "archived",
};

export const glyphState = (glyph: WorkerGlyph): DotState => GLYPH_STATE[glyph];

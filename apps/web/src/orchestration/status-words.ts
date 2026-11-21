import type { RailTone } from "./rail-model";
import type { WorkerGlyph } from "./workers-model";

/** Every state a dot can say: a worker's tone, a finished or archived worker, and a held brief. */
export type DotState = RailTone | "done" | "archived" | "held";

export const STATUS_WORDS: Readonly<Record<DotState, string>> = {
  needs: "Needs you",
  working: "Running",
  waiting: "Waiting",
  attention: "Stopped",
  error: "Failed",
  idle: "Stopped",
  merged: "Done",
  done: "Done",
  archived: "Done",
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

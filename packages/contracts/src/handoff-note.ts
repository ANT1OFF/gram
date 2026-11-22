import * as Schema from "effect/Schema";
import { AgentKind } from "./agent-kind.ts";

/** The longest a switch's handoff note may be; a longer reply is cut. */
export const HANDOFF_NOTE_MAX_CHARS = 4000;
/** The longest a switch's facts block may be. */
export const HANDOFF_FACTS_MAX_CHARS = 16_000;

/** How a switch's handoff note is written (`Handoff.noteMode`). */
export const SwitchNoteMode = Schema.Literals(["outgoing", "limit", "none"]);
export type SwitchNoteMode = typeof SwitchNoteMode.Type;

/** A switch's handoff note: its text, and the agent that wrote it. */
export const HandoffNote = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(HANDOFF_NOTE_MAX_CHARS)),
  by: AgentKind,
});
export type HandoffNote = typeof HandoffNote.Type;

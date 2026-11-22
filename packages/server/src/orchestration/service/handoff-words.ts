import type { AgentKind, OrchestratorHandoffReason } from "@gram/contracts";
import { AGENT_NAMES } from "../../runtime/agent-names.ts";

const HANDOFF_WHY: Record<OrchestratorHandoffReason, string> = {
  user: "The user asked for a handoff",
  context: "Your context is nearly full",
  compactions: "Your conversation has been compacted more than once",
};

export const checkpointNote = (reason: OrchestratorHandoffReason): string =>
  `${HANDOFF_WHY[reason]}, so when this turn ends your session is replaced by a fresh one. It starts from your role, MEMORY.md, the ledger, the charter and your last few exchanges with the user, and remembers nothing else of this conversation. Write down now, with \`memory_write\`, whatever isn't in memory yet and can't be derived: goals and priorities, decisions and why, open questions for the user, what you were in the middle of. Only flush; tidying is for later. Don't spawn or message workers in this turn. When you are done, reply \`ready\` and end your turn.`;

export const switchCheckpointNote = (from: AgentKind, to: AgentKind): string =>
  `The user asked to move you to ${from === to ? `a fresh ${AGENT_NAMES[to]} session` : AGENT_NAMES[to]}, so when this turn ends your session is replaced by a fresh one. It starts from your role, MEMORY.md, the ledger and the charter, with your handoff note and the last exchanges with the user, and remembers nothing else of this conversation. Write down now, with \`memory_write\`, whatever isn't in memory yet and can't be derived: goals and priorities, decisions and why, open questions for the user, what you were in the middle of. Only flush; tidying is for later. Don't spawn or message workers in this turn. When you are done, reply with a handoff note for the new session: the goal, what's done, what's in progress, decisions and why, what's next, and traps. Reply with the note only, and end your turn.`;

export const HANDOFF_BOOT_REASON = "a fresh session after a handoff";
/**
 * The same, when the old session wrote nothing to memory first: what it was in the middle of may
 * be missing from memory, so the new one checks the ledger before acting on memory alone.
 */
export const HANDOFF_UNSAVED_BOOT_REASON =
  "a fresh session after a handoff that skipped saving to memory, so memory may be missing what the last session was doing: check the ledger and workers' reports before acting on memory alone";

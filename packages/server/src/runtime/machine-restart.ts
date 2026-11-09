// A joined machine that restarted under a thread's session (`EndedEvent.restartedMachine`): what
// the thread does next. The conversation is still on that machine, so a turn the restart cut short
// goes on there in the same Claude session, unless the user is the one it waits on.

/** The `noticeKeys` key of the queued note a continued turn starts with. */
export const MACHINE_RESTART_KEY = "machine-restart";

/** How many times a thread's work is carried on after a machine restart within `WINDOW`. */
export const MACHINE_RESTART_CONTINUATIONS = 3;
export const MACHINE_RESTART_WINDOW_MS = 60 * 60_000;

/** The note the continued turn starts with, in Gram's words. */
export const machineRestartText = (machine: string): string =>
  `Note: ${machine}, the machine this session runs on, restarted and cut your last turn short. ` +
  "This is the same conversation, resumed there. Anything that was running with it (shells, " +
  "background tasks, subagents) stopped. Continue where you left off.";

/**
 * What a session's end on a restarted machine leaves the thread to do:
 * - `continue`: open the same conversation there again and carry on the cut turn, or the queue;
 * - `rest`: nothing was going on, or the user had stopped the turn, so the thread just rests;
 * - `fail`: the turn waited on the user, or the machine restarted too often, so it fails as any
 *   session that ended under a turn does, saying why.
 */
export type AfterMachineRestart =
  | { readonly kind: "continue"; readonly machine: string; readonly continued: "turn" | "queue" }
  | { readonly kind: "rest"; readonly machine: string }
  | { readonly kind: "fail"; readonly machine: string; readonly reason: string };

/** What the thread was doing as its session ended. */
export interface RestartFacts {
  readonly machine: string;
  /** A turn was open and the agent had its input: the restart cut it short. */
  readonly turnCut: boolean;
  /** A turn was open at all, its input taken or not. */
  readonly turnOpen: boolean;
  /** The user asked to stop that turn, or a pause to end it at its next tool boundary. */
  readonly stopAsked: boolean;
  /** Something is queued to go next: the user's messages, or a system delivery. */
  readonly queued: boolean;
  /** The turn waited on the user: an approval, a question or a plan. */
  readonly waitingOnUser: boolean;
  /** When the thread's work was last carried on after a machine restart, epoch ms. */
  readonly recent: ReadonlyArray<number>;
  readonly now: number;
}

/** The decision, and the continuation times to keep for the next one. */
export const afterMachineRestart = (
  facts: RestartFacts,
): { readonly next: AfterMachineRestart; readonly recent: ReadonlyArray<number> } => {
  const { machine, now } = facts;
  const recent = facts.recent.filter((at) => now - at < MACHINE_RESTART_WINDOW_MS);
  if (facts.turnOpen && facts.stopAsked) return { next: { kind: "rest", machine }, recent };
  if (!facts.turnOpen && !facts.queued) return { next: { kind: "rest", machine }, recent };
  if (facts.waitingOnUser)
    return {
      next: {
        kind: "fail",
        machine,
        reason: `${machine} restarted while this turn waited on you, so Gram didn't continue it. Send a message to carry on.`,
      },
      recent,
    };
  if (recent.length >= MACHINE_RESTART_CONTINUATIONS)
    return {
      next: {
        kind: "fail",
        machine,
        reason: `${machine} restarted again, and Gram already continued this thread ${MACHINE_RESTART_CONTINUATIONS} times in the last hour, so it waits for you this time.`,
      },
      recent,
    };
  return {
    next: { kind: "continue", machine, continued: facts.turnCut ? "turn" : "queue" },
    recent: [...recent, now],
  };
};

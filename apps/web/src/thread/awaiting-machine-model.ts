import type { Thread } from "@gram/contracts";

// A thread started before its machine (`Thread.awaitingMachine`): what its wait reads as, wherever
// the thread is shown. It is stored and takes messages, which wait in its queue; no session opens
// until whoever runs the machines names one for it. No React.

/**
 * How the wait stands: a machine is starting, one is starting again after the first didn't, or
 * none came (`failed`).
 */
export type MachineWaitState = "starting" | "again" | "failed";

export interface MachineWait {
  readonly state: MachineWaitState;
  /** Epoch ms the wait counts from: its start, or the last try. */
  readonly since: number;
  /** Why no machine came, in a sentence for the person; set while `failed`. */
  readonly sentence?: string;
}

/** A try the person asked for here, which the thread itself doesn't say yet. */
export interface AskedAgain {
  /** Epoch ms they asked. */
  readonly at: number;
  /** The failure they asked after (`failed.at`): a later one is the new try's own. */
  readonly after: number;
}

/**
 * Gram's own sentence for a wait that ran out (the server's `NO_MACHINE_CAME`), which already says
 * the messages are kept; the line under the failure says that for every sentence, so the failure's
 * head keeps its first sentence alone.
 */
const KEPT_TAIL = " What you sent is kept, and goes once one has.";

/** The failure's sentence as its head says it: the platform's own, or Gram's without its tail. */
export const failureSentence = (message: string): string => {
  const said = message.trim();
  const head = said.endsWith(KEPT_TAIL.trim()) ? said.slice(0, -KEPT_TAIL.trim().length) : said;
  return head.trim() === "" ? WAIT_WORDS.failed : head.trim();
};

/**
 * The wait of `thread`, or `undefined` for a thread that doesn't wait. `asked` is a try the person
 * asked for here: until the thread says otherwise (the wait begun again, or a newer failure), it
 * reads as starting again from when they asked.
 */
export const machineWait = (
  thread: Pick<Thread, "awaitingMachine" | "createdAt">,
  asked?: AskedAgain | undefined,
): MachineWait | undefined => {
  const waiting = thread.awaitingMachine;
  if (waiting === undefined) return undefined;
  if (waiting.failed !== undefined) {
    if (asked !== undefined && asked.after === waiting.failed.at)
      return { state: "again", since: asked.at };
    return {
      state: "failed",
      since: waiting.since,
      sentence: failureSentence(waiting.failed.message),
    };
  }
  // A wait begun again counts from then; the first counts from the thread's own start.
  return { state: waiting.since > thread.createdAt ? "again" : "starting", since: waiting.since };
};

/** Every word the wait is said in, so the header, the conversation and the lists agree. */
export const WAIT_WORDS = {
  /** The header's chip, and its shorter form where room is short. */
  chip: { starting: "machine starting", short: "starting", failed: "no machine" },
  /** The line in the conversation: its head, and what follows it. */
  starting: "Starting this thread's machine",
  startingNote: "usually under a minute",
  again: "Starting a machine again",
  againNote: "the first didn't start",
  /** Gram's sentence when no machine came and nobody gave another. */
  failed: "No machine started for this thread.",
  kept: "What you sent is kept, and goes once a machine has started.",
  /** With nobody to ask for another machine: the way that is always there. */
  keptNoRetry: "What you sent is kept. To try again, start the thread again.",
  retry: "Try again",
  retryFailed: "Couldn't ask for another machine.",
  /** Under the held message. */
  heldStarting: "sent when the machine has started",
  heldFailed: "not sent yet, and kept",
  /** The queue's heading while the thread waits. */
  queue: "Queued · waits for the machine",
  /** The prompt box. */
  composeStarting: "Add a message. It is sent when the machine has started.",
  composeFailed: "Add a message. It is kept until a machine has started.",
  composePhone: "Add a message. It waits for the machine.",
  /** A row's status word and its hover. */
  rowStarting: "Machine starting",
  rowFailed: "No machine",
  rowStartingHint: "Its machine is starting",
  rowFailedHint: "No machine started · Try again in the thread",
} as const;

/** "1 message waits", "3 messages wait"; nothing for none. */
export const waitsWords = (count: number): string | undefined =>
  count <= 0 ? undefined : count === 1 ? "1 message waits" : `${count} messages wait`;

/** A row's hover while its machine starts: "Its machine is starting · 1 message waits". */
export const startingHint = (waits: number): string =>
  [WAIT_WORDS.rowStartingHint, waitsWords(waits)].filter((each) => each !== undefined).join(" · ");

/** How long the wait has run, as a clock: `0:42`, `12:07`, `1:02:03`. */
export const elapsedClock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const s = String(seconds % 60).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${s}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
};

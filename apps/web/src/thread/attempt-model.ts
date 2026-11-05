import type { GramUIMessage, ThreadError, TurnEnd } from "@gram/contracts";

// What became of a failed turn and of a stopped one, read from the transcript alone: a failed turn
// whose message was sent again is "Retried", and the attempt that sent it is the one to look at; a
// turn the user stopped ends on "Stopped". No React.

/** A failed turn's error, as its transcript card names it: by when it failed and in which turn. */
export const errorKey = (error: Pick<ThreadError, "at" | "turnId">): string =>
  `${error.turnId ?? ""}@${error.at}`;

/** What became of a failed turn whose message was sent again. */
export interface RetryReceipt {
  /** The user message that sent it again: the new attempt. */
  readonly messageId: string;
  /** Epoch ms it was sent, when the message says. */
  readonly at: number | undefined;
  /** Whether that attempt failed too. */
  readonly failed: boolean;
  /** The newest attempt of the same message, the one that needs action when it failed too. */
  readonly latestMessageId: string;
  readonly latestFailed: boolean;
  /** The newest attempt ran to its end without failing: the turn recovered. */
  readonly recovered: boolean;
}

/** A failure the run's one card lists under its disclosure: an attempt before the one it shows. */
export interface EarlierAttempt {
  readonly attempt: number;
  readonly error: ThreadError;
}

/** A failed turn's place in the run of attempts at one message. */
export interface AttemptFacts {
  /** 1 for the first try, 2 for its first retry, and so on. */
  readonly attempt: number;
  /** How many attempts at the message there have been so far, this one included. */
  readonly of: number;
  /** Set once the message was sent again after it. */
  readonly retried?: RetryReceipt | undefined;
  /**
   * The run's card stands for this failure: a later failure at the same message shows it among its
   * earlier attempts, so its own card draws nothing.
   */
  readonly folded: boolean;
  /** On the run's card: the failures before the one it shows, oldest first. */
  readonly earlier: readonly EarlierAttempt[];
}

const textOf = (message: GramUIMessage): string | undefined => {
  if (message.parts.some((part) => part.type !== "text" && !part.type.startsWith("data-"))) {
    return undefined;
  }
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim();
  return text === "" ? undefined : text;
};

/** A message the user sent: not Gram's own notice on the user's side. */
const sentByUser = (message: GramUIMessage): boolean =>
  message.role === "user" && message.metadata?.author !== "server";

const errorsIn = (message: GramUIMessage): ThreadError[] =>
  message.parts.flatMap((part) => (part.type === "data-agent-error" ? [part.data] : []));

interface Turn {
  readonly messageId: string;
  readonly text: string | undefined;
  readonly at: number | undefined;
  readonly errors: ThreadError[];
  /** Its reply's end was written as completed. */
  completed: boolean;
}

/** A run of the same words sent one after another, each failure but the last retried. */
type Run = readonly Turn[];

/** The transcript as user turns, each with the errors its reply ended on, and its runs of retries. */
const runsOf = (messages: readonly GramUIMessage[]): { turns: Turn[]; runs: Run[] } => {
  const turns: Turn[] = [];
  const turnOf = new Map<string, Turn>();
  for (const message of messages) {
    if (sentByUser(message)) {
      const turn: Turn = {
        messageId: message.id,
        text: textOf(message),
        at: message.metadata?.createdAt,
        errors: [],
        completed: false,
      };
      turns.push(turn);
      const turnId = message.metadata?.turnId;
      if (turnId !== undefined) turnOf.set(turnId, turn);
      continue;
    }
    if (message.role !== "assistant" || message.metadata?.parentToolUseId !== undefined) continue;
    const errors = errorsIn(message);
    const turnId = errors[0]?.turnId ?? message.metadata?.turnId;
    const owner = (turnId === undefined ? undefined : turnOf.get(turnId)) ?? turns.at(-1);
    if (owner === undefined) continue;
    owner.errors.push(...errors);
    if (message.metadata?.turnEnd?.reason === "completed") owner.completed = true;
  }

  const runs: Run[] = [];
  for (let i = 0; i < turns.length; i++) {
    const first = turns[i]!;
    if (first.errors.length === 0 || first.text === undefined) continue;
    const run: Turn[] = [first];
    for (let j = i + 1; j < turns.length; j++) {
      const next = turns[j]!;
      if (next.text !== first.text) break;
      run.push(next);
      if (next.errors.length === 0) break;
    }
    runs.push(run);
    i += run.length - 1;
  }
  return { turns, runs };
};

/**
 * Each failed turn's attempt facts by `errorKey`: which try it was at its message, and, once the
 * same words were sent again, that retry and the newest attempt after it. Only an identical message
 * counts as a retry; anything else the user wrote is a new turn of its own.
 *
 * A run of attempts shows as one card: the last failure's, with the failures before it listed as
 * `earlier` and each of those `folded`.
 */
export const attemptsOf = (
  messages: readonly GramUIMessage[],
): ReadonlyMap<string, AttemptFacts> => {
  const out = new Map<string, AttemptFacts>();
  for (const run of runsOf(messages).runs) {
    const latest = run.at(-1)!;
    const failures = run.flatMap((turn, index) =>
      turn.errors.map((error) => ({ attempt: index + 1, error })),
    );
    const shown = failures.at(-1)!;
    const recovered = latest.errors.length === 0 && latest.completed;
    run.forEach((turn, index) => {
      const retry = run[index + 1];
      for (const error of turn.errors) {
        const key = errorKey(error);
        if (out.has(key)) continue;
        const card = error === shown.error;
        out.set(key, {
          attempt: index + 1,
          of: run.length,
          retried:
            retry === undefined
              ? undefined
              : {
                  messageId: retry.messageId,
                  at: retry.at,
                  failed: retry.errors.length > 0,
                  latestMessageId: latest.messageId,
                  latestFailed: latest.errors.length > 0,
                  recovered,
                },
          folded: !card,
          earlier: card ? failures.slice(0, -1) : [],
        });
      }
    });
  }
  return out;
};

/** Parts that draw nothing on their own, so a reply of only these and folded failures is empty. */
const SILENT_PARTS: ReadonlySet<string> = new Set([
  "step-start",
  "data-tool-image",
  "data-subagent-usage",
]);

/**
 * The messages a run of retries leaves out of the transcript: each retry's user message, which
 * repeats the words above it, and a reply that is nothing but a failure the run's card stands for.
 * The run's card says which attempt it is and lists the ones before it.
 */
export const retryHiddenOf = (messages: readonly GramUIMessage[]): ReadonlySet<string> => {
  const { runs } = runsOf(messages);
  if (runs.length === 0) return NO_HIDDEN;
  const attempts = attemptsOf(messages);
  const hidden = new Set<string>();
  for (const run of runs) for (const turn of run.slice(1)) hidden.add(turn.messageId);
  for (const message of messages) {
    if (message.role !== "assistant" || message.metadata?.parentToolUseId !== undefined) continue;
    let folded = false;
    const drawn = message.parts.some((part) => {
      if (part.type === "data-agent-error") {
        if (attempts.get(errorKey(part.data))?.folded === true) {
          folded = true;
          return false;
        }
        return true;
      }
      if (part.type === "text") return part.text.trim() !== "";
      return !SILENT_PARTS.has(part.type);
    });
    if (folded && !drawn) hidden.add(message.id);
  }
  return hidden;
};

const NO_HIDDEN: ReadonlySet<string> = new Set();

/** How long after the user pressed Stop the turn may still end and be theirs to have stopped. */
const STOP_SETTLE_MS = 120_000;

/** How the transcript's last turn ended, when it was stopped. */
export interface StopReceipt {
  /** Epoch ms the turn ended. */
  readonly at: number;
  /** Whether the user stopped it from here, rather than a restart, a pause or the orchestrator. */
  readonly byYou: boolean;
}

/**
 * The stop the transcript ends on: its last reply ended `interrupted` with nothing sent after it,
 * or, where that reply's end was never written, the Stop the user pressed at `stoppedAt` after
 * the last message went. `undefined` once anything follows it.
 */
export const stopOf = (
  messages: readonly GramUIMessage[],
  stoppedAt: number | undefined,
): StopReceipt | undefined => {
  const last = messages.findLast((m) => m.metadata?.parentToolUseId === undefined);
  if (last === undefined) return undefined;
  const sent = messages.findLast(sentByUser)?.metadata?.createdAt;
  const yours = (at: number) =>
    stoppedAt !== undefined &&
    (sent === undefined || sent <= stoppedAt) &&
    at >= stoppedAt - 1_000 &&
    at - stoppedAt <= STOP_SETTLE_MS;
  if (last.role === "assistant") {
    const end: TurnEnd | undefined = last.metadata?.turnEnd;
    if (end?.reason === "interrupted") return { at: end.at, byYou: yours(end.at) };
    if (end !== undefined || stoppedAt === undefined) return undefined;
    // A reply cut off before its end was written.
    return yours(stoppedAt) ? { at: stoppedAt, byYou: true } : undefined;
  }
  if (stoppedAt === undefined || !sentByUser(last)) return undefined;
  return yours(stoppedAt) ? { at: stoppedAt, byYou: true } : undefined;
};

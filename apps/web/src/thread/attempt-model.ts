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
}

/** A failed turn's place in the run of attempts at one message. */
export interface AttemptFacts {
  /** 1 for the first try, 2 for its first retry, and so on. */
  readonly attempt: number;
  /** Set once the message was sent again after it. */
  readonly retried?: RetryReceipt | undefined;
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
}

/**
 * Each failed turn's attempt facts by `errorKey`: which try it was at its message, and, once the
 * same words were sent again, that retry and the newest attempt after it. Only an identical message
 * counts as a retry; anything else the user wrote is a new turn of its own.
 */
export const attemptsOf = (
  messages: readonly GramUIMessage[],
): ReadonlyMap<string, AttemptFacts> => {
  // The transcript as user turns, each with the errors its reply ended on.
  const turns: Turn[] = [];
  for (const message of messages) {
    if (sentByUser(message)) {
      turns.push({
        messageId: message.id,
        text: textOf(message),
        at: message.metadata?.createdAt,
        errors: [],
      });
      continue;
    }
    if (message.role !== "assistant") continue;
    const errors = errorsIn(message);
    if (errors.length === 0) continue;
    const owner =
      errors[0]?.turnId === undefined
        ? undefined
        : turns.findLast(
            (turn) =>
              messages.find((m) => m.id === turn.messageId)?.metadata?.turnId === errors[0]?.turnId,
          );
    (owner ?? turns.at(-1))?.errors.push(...errors);
  }

  const out = new Map<string, AttemptFacts>();
  // Runs of the same words sent one after another, each failure but the last retried.
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
    const latest = run.at(-1)!;
    run.forEach((turn, index) => {
      const retry = run[index + 1];
      for (const error of turn.errors) {
        const key = errorKey(error);
        if (out.has(key)) continue;
        out.set(key, {
          attempt: index + 1,
          retried:
            retry === undefined
              ? undefined
              : {
                  messageId: retry.messageId,
                  at: retry.at,
                  failed: retry.errors.length > 0,
                  latestMessageId: latest.messageId,
                  latestFailed: latest.errors.length > 0,
                },
        });
      }
    });
    i += run.length - 1;
  }
  return out;
};

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

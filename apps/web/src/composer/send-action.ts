export type SendAction = "send" | "queue" | "steer" | "stop";

/**
 * What the composer's one round button does. An empty composer can only stop what is running, so
 * Stop has it then; with anything in the composer it sends, into the queue during a turn, or into
 * the turn itself when `steering`.
 */
export function sendAction({
  hasDraft,
  busy,
  background,
  steering,
}: {
  /** Anything in the composer, sendable yet or not: a draft waiting on an upload isn't Stop. */
  hasDraft: boolean;
  busy: boolean;
  /** The turn is over but a background agent is still working, which Stop reaches too. */
  background: boolean;
  /** The modifier is down on a turn that takes input. */
  steering: boolean;
}): SendAction {
  if (!hasDraft) return busy || background ? "stop" : "send";
  if (!busy) return "send";
  return steering ? "steer" : "queue";
}

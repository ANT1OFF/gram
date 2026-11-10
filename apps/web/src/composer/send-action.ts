export type SendAction = "send" | "queue" | "steer" | "interrupt" | "stop";

/** A modifier the user holds to deliver a draft other than as a steer: ⌥ queues, ⌘/Ctrl interrupts. */
export type HeldDelivery = "queue" | "interrupt" | undefined;

/**
 * What the composer's one round button does. An empty composer can only stop what is running, so
 * Stop has it then. With anything in the composer it sends at rest; during a turn that takes input
 * it steers (after the tool calls under way, cancelling nothing), queues with ⌥ and interrupts with
 * ⌘/Ctrl; into a turn that can't take input it queues.
 */
export function sendAction({
  hasDraft,
  busy,
  background,
  steerable,
  held,
}: {
  /** Anything in the composer, sendable yet or not: a draft waiting on an upload isn't Stop. */
  hasDraft: boolean;
  busy: boolean;
  /** The turn is over but a background agent is still working, which Stop reaches too. */
  background: boolean;
  /** The turn is running and its agent takes input mid-turn. */
  steerable: boolean;
  held: HeldDelivery;
}): SendAction {
  if (!hasDraft) return busy || background ? "stop" : "send";
  if (!busy) return "send";
  if (!steerable || held === "queue") return "queue";
  return held === "interrupt" ? "interrupt" : "steer";
}

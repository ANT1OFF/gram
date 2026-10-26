import type { NotifyAbout, ServerEvent } from "@gram/contracts";

// What may interrupt you with a desktop notification while the window isn't in front, in one table.
// Only asks and failures do, or only asks with Settings → General → Notify me about at Asks only. Everything else waits for "Since you left" or stays in the app's own
// notification center; macOS Focus can still hold even these.

/** What happened, as far as interrupting goes. */
export type AwayEvent =
  /** An ask in the stack: an approval, a question or a plan waiting on you. */
  | "ask"
  /** Wants you without an ask in the stack: a review requested, a paused workspace. */
  | "needsYou"
  /** Something failed: red CI, a run that didn't succeed, an agent that stopped. */
  | "failure"
  /** A pull request merged. */
  | "merge"
  /** Work finished: a thread done, checks passed, a PR ready. */
  | "done"
  /** A worker woke from a timer or a watched event. */
  | "wake"
  /** A feature moved a stage. */
  | "stage"
  /** A worker's progress report. */
  | "progress"
  /** Anything else the app says in passing. */
  | "info";

/** `interrupt` raises a desktop notification; the rest never do. */
export type Delivery = "interrupt" | "sinceYouLeft" | "inApp";

/** The interrupt policy. */
export const INTERRUPT_POLICY = {
  ask: "interrupt",
  needsYou: "interrupt",
  failure: "interrupt",
  merge: "sinceYouLeft",
  done: "sinceYouLeft",
  wake: "sinceYouLeft",
  stage: "sinceYouLeft",
  progress: "sinceYouLeft",
  info: "inApp",
} as const satisfies Readonly<Record<AwayEvent, Delivery>>;

/**
 * Whether `event` may raise a desktop notification. With `notifyAbout` at `asks`, a failure waits
 * for "Since you left" too; asks and wants-you notices still interrupt.
 */
export const interrupts = (
  event: AwayEvent,
  notifyAbout: NotifyAbout = "asksAndFailures",
): boolean =>
  INTERRUPT_POLICY[event] === "interrupt" && !(notifyAbout === "asks" && event === "failure");

type Notify = Extract<ServerEvent, { type: "notify" }>;

/** A server notice's place in the table, by its kind. */
export const awayEventOf = (notice: Pick<Notify, "kind">): AwayEvent => {
  switch (notice.kind) {
    case "error":
      return "failure";
    case "needsInput":
      return "needsYou";
    case "done":
      return "done";
    case "info":
      return "info";
  }
};

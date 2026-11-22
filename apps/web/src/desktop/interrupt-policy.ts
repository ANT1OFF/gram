import type { NotifyAbout, ServerEvent } from "@gram/contracts";

/** What happened, as far as interrupting goes. */
export type AwayEvent =
  | "ask"
  | "needsYou"
  | "failure"
  | "merge"
  | "done"
  | "wake"
  | "stage"
  | "progress"
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

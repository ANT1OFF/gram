import * as Data from "effect/Data";

/**
 * Input a session couldn't hand its agent, or can't say it did: its host didn't answer, or the
 * session ended first. A session's `send` and `steer` die with it, as an adapter whose transport
 * broke does, so the runtime keeps the input rather than count it taken (`sendNow`, `steerNow`).
 */
export class InputUndelivered extends Data.TaggedError("InputUndelivered")<{
  readonly message: string;
}> {}

/** Whether `defect`, what a session's `send` or `steer` died with, is `InputUndelivered`. */
export const isUndelivered = (defect: unknown): defect is InputUndelivered =>
  defect instanceof InputUndelivered;

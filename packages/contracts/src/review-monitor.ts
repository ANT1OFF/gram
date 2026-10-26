import * as Schema from "effect/Schema";
import { BoundPr } from "./domain.ts";

/**
 * `thread.setReviewMonitor`: the thread's bound PR after the change. Absent when turning the monitor
 * off on a thread that has no PR to watch.
 */
export const ReviewMonitorResult = Schema.Struct({
  bound: Schema.optionalKey(BoundPr),
});
export type ReviewMonitorResult = typeof ReviewMonitorResult.Type;

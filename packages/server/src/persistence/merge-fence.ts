import { ThreadId } from "@gram/contracts";
import * as Schema from "effect/Schema";

/** Written before the external merge, independently of a thread or intent's lifetime. */
export const PendingMerge = Schema.Struct({
  pr: Schema.Struct({ repo: Schema.String, number: Schema.Number }),
  threadId: ThreadId,
  head: Schema.String,
  tip: Schema.optionalKey(Schema.String),
  at: Schema.Number,
  /** Only a definitive provider rejection, never a timeout or an arbitrary nonzero exit. */
  confirmedFailure: Schema.optionalKey(Schema.Literal(true)),
});
export type PendingMerge = typeof PendingMerge.Type;

/** One base's durable uncertainty and tips already moved by Gram. No expiry. */
export const MergeFence = Schema.Struct({
  key: Schema.String,
  moved: Schema.Array(Schema.String),
  pending: Schema.optionalKey(PendingMerge),
});
export type MergeFence = typeof MergeFence.Type;

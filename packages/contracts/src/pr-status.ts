import * as Schema from "effect/Schema";
import { BoundPr } from "./domain.ts";
import { PrStatus } from "./git.ts";

/** `pr.status`: the thread's bound PR and its last known status. */
export const PrStatusResult = Schema.Struct({
  bound: Schema.optionalKey(BoundPr),
  /** Absent until the batched `gh` query has resolved the PR. */
  pr: Schema.optionalKey(PrStatus),
});
export type PrStatusResult = typeof PrStatusResult.Type;

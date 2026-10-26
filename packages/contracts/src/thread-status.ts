import * as Schema from "effect/Schema";

/**
 * The runtime state machine. The human activity line for the sidebar row travels
 * alongside it as `detail` on the `thread.status` event.
 *
 * In a file of its own, re-exported by `domain.ts`: the orchestration ledger names a worker's
 * status and `domain.ts` imports the digest built from that ledger, so defining it there would
 * close an import cycle.
 */
export const ThreadStatus = Schema.Literals([
  "cold",
  "starting",
  "idle",
  "running",
  "needsApproval",
  "needsInput",
  "error",
  "ended",
]);
export type ThreadStatus = typeof ThreadStatus.Type;

/**
 * A compaction under way: the agent is replacing the conversation with a summary of it. Rides on
 * the `compacting` agent status, `thread.status` and the thread's summary until the agent reports
 * it done, when the transcript's compaction marker (`CompactionDataSchema`) takes over.
 */
export const CompactionActivity = Schema.Struct({
  /** Epoch ms, as the adapter saw the agent start. */
  startedAt: Schema.Number,
  /** `manual` for `/compact`, `auto` when the agent makes room; absent until the agent says. */
  trigger: Schema.optionalKey(Schema.Literals(["manual", "auto"])),
  /** The context it is compacting, in tokens: the last reading before it started. */
  preTokens: Schema.optionalKey(Schema.Int),
});
export type CompactionActivity = typeof CompactionActivity.Type;

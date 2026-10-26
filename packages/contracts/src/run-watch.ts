import * as Schema from "effect/Schema";

/** An explicitly monitored workflow run; removed only by the monitor lifecycle. */
export const RunWatch = Schema.Struct({
  /** `owner/repo`. */
  repo: Schema.String,
  runId: Schema.Int,
  /** The workflow's name and the run's title, when the lookup that set the watch read them. */
  name: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  /** Epoch ms the watch was set. */
  since: Schema.Number,
});
export type RunWatch = typeof RunWatch.Type;

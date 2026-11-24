import * as Schema from "effect/Schema";

/**
 * What `getTaskOutput` answers: SDK 0.3.296's `SDKControlGetTaskOutputResponse` (`sdk.d.ts`), the
 * last 8 KiB the command wrote, stdout and stderr together.
 */
export const TaskOutputRead = Schema.Struct({
  output: Schema.String,
  total_bytes: Schema.Number,
  truncated: Schema.Boolean,
});
export type TaskOutputRead = typeof TaskOutputRead.Type;

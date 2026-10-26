import * as Schema from "effect/Schema";

export const PushResult = Schema.Struct({
  branch: Schema.String,
  /** The branch had no upstream and was pushed with `-u origin <branch>`. */
  published: Schema.Boolean,
});
export type PushResult = typeof PushResult.Type;

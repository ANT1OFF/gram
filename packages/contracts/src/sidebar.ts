import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/**
 * `threads.reorder`: the manually ordered sidebar, top to bottom. Each listed thread's `sortOrder`
 * becomes its index; unknown ids are ignored, and threads left out keep their position.
 */
export const ReorderThreadsPayload = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});
export type ReorderThreadsPayload = typeof ReorderThreadsPayload.Type;

import * as Schema from "effect/Schema";
import { ThreadId } from "./ids.ts";

/**
 * `thread.create` refused because another open thread already uses the worktree at `path`. `message`
 * keeps the wording the server always sent, so matchers on it keep working.
 */
export class CheckoutInUse extends Schema.TaggedError<CheckoutInUse>()("CheckoutInUse", {
  path: Schema.String,
  message: Schema.String,
}) {}

/**
 * `threads.usingCheckout`: the open threads (parked ones included) whose checkout, or the folder they
 * followed the agent into, is `path`, compared the way the server compares checkouts.
 */
export const CheckoutUsersPayload = Schema.Struct({ path: Schema.String });
export type CheckoutUsersPayload = typeof CheckoutUsersPayload.Type;

export const CheckoutUser = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  parked: Schema.Boolean,
});
export type CheckoutUser = typeof CheckoutUser.Type;

export const CheckoutUsers = Schema.Struct({ threads: Schema.Array(CheckoutUser) });
export type CheckoutUsers = typeof CheckoutUsers.Type;

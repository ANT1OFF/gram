import * as Schema from "effect/Schema";
import type { Checkout, Thread } from "./domain.ts";

/** Where the agent reported it's working: after a tool call that moved it, and at every turn end. */
export const CwdEvent = Schema.Struct({
  type: Schema.Literal("cwd"),
  cwd: Schema.String,
});

/** The checkout the thread's work is in: the worktree it followed the agent into, else its own. */
export const effectiveCheckout = (thread: Pick<Thread, "checkout" | "currentCheckout">): Checkout =>
  thread.currentCheckout ?? thread.checkout;

/**
 * Every folder the thread's files are in: its effective checkout first, then the worktrees in other
 * repos a worker spanning them holds (`extraCheckouts`).
 */
export const checkoutRoots = (
  thread: Pick<Thread, "checkout" | "currentCheckout" | "extraCheckouts">,
): string[] => [
  effectiveCheckout(thread).path,
  ...(thread.extraCheckouts ?? []).map((extra) => extra.path),
];

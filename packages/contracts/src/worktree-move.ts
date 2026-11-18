import * as Schema from "effect/Schema";
import type { Checkout, Thread } from "./domain.ts";
import type { HostId } from "./ids.ts";
import { hostOf } from "./hosts.ts";

/** Where the agent reported it's working: after a tool call that moved it, and at every turn end. */
export const CwdEvent = Schema.Struct({
  type: Schema.Literal("cwd"),
  cwd: Schema.String,
});

/** The checkout the thread's work is in: the worktree it followed the agent into, else its own. */
export const effectiveCheckout = (thread: Pick<Thread, "checkout" | "currentCheckout">): Checkout =>
  thread.currentCheckout ?? thread.checkout;

/**
 * The machine a thread's agent session runs on: its folder's, or for a memory update on a server
 * that runs no work itself, the machine it was given (`Thread.dreamHost`).
 */
export const sessionHostOf = (
  thread: Pick<Thread, "checkout" | "currentCheckout" | "dreamHost">,
): HostId => thread.dreamHost ?? hostOf(effectiveCheckout(thread));

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

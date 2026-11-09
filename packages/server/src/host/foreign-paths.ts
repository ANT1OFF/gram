import { type Checkout, isLocalHost, type Thread } from "@gram/contracts";
import { noteForeignPath } from "@gram/git";

/** Marks one checkout on another machine, and its repository, as that machine's. */
const noteForeign = (checkout: Checkout | undefined): void => {
  if (checkout === undefined || isLocalHost(checkout)) return;
  noteForeignPath(checkout.path);
  if (checkout.repoRoot !== undefined) noteForeignPath(checkout.repoRoot);
};

/**
 * Marks the folders a thread holds on another machine (its checkouts and their repositories) as
 * that machine's, so comparing them here never asks this filesystem (`noteForeignPath`). Called
 * wherever threads are read or written, before anything keys or compares their paths.
 */
export const noteForeignCheckouts = (
  thread: Pick<Thread, "checkout" | "currentCheckout" | "extraCheckouts">,
): void => {
  noteForeign(thread.checkout);
  noteForeign(thread.currentCheckout);
  for (const extra of thread.extraCheckouts ?? []) noteForeign(extra);
};

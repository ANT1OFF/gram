import type { SignedTurnGrant } from "@gram/contracts";

import { sleep } from "@/lib/sleep";

/** How long a send waits for the desktop app's grant before it goes without one. */
export const HOSTED_SITE_GRANT_WAIT_MS = 2_000;

/**
 * The turn grant for a message the person is sending to `threadId` now, when this page is a
 * hosted server's site open in the desktop app's window for it, and that app lends this computer
 * to the workspace. Without one the message is sent as any other, so any failure here is none.
 */
export const hostedSiteGrant = async (
  threadId: string,
  site = typeof window === "undefined" ? undefined : window.gramHostedSite,
): Promise<SignedTurnGrant | undefined> => {
  if (site === undefined) return undefined;
  try {
    const late = sleep(HOSTED_SITE_GRANT_WAIT_MS).then(() => null);
    return (await Promise.race([site.turnGrant(threadId), late])) ?? undefined;
  } catch {
    return undefined;
  }
};

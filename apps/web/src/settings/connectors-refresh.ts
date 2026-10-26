import type { ConfiguredConnectors } from "@gram/contracts";

/** How soon the page asks again while the server's read behind its last answer hasn't landed. */
export const REFRESH_POLL_MS = 1_000;

/** Poll only while the local configuration read is still in progress. */
export function nextConfiguredRead(configured: ConfiguredConnectors | undefined): number | false {
  return configured?.refreshing === true ? REFRESH_POLL_MS : false;
}

/** Below this, fetching code nobody asked for yet competes with what the person is waiting for. */
const SLOW_BITS_PER_SECOND = 1_000_000;
/** Smaller downloads say more about latency than about the link's rate. */
const MEASURABLE_BYTES = 100_000;

interface Download {
  readonly transferSize: number;
  readonly requestStart: number;
  readonly responseEnd: number;
}

interface ConnectionHint {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/**
 * Whether this window came up over a slow or metered link, from how fast its own first downloads
 * arrived: the largest file fetched over the network, bytes on the wire over the time from request
 * to last byte. A cached launch measures nothing, so it falls back to what the browser says of the
 * connection where it says anything (Safari and Firefox do not). Unknown counts as a good link.
 */
export function linkIsConstrained(
  downloads: readonly Download[],
  connection?: ConnectionHint,
): boolean {
  if (connection?.saveData === true) return true;
  let largest: Download | undefined;
  for (const download of downloads) {
    if (download.transferSize < MEASURABLE_BYTES) continue;
    if (largest === undefined || download.transferSize > largest.transferSize) largest = download;
  }
  if (largest !== undefined) {
    const seconds = (largest.responseEnd - largest.requestStart) / 1000;
    if (seconds > 0) return (largest.transferSize * 8) / seconds < SLOW_BITS_PER_SECOND;
  }
  const type = connection?.effectiveType;
  return type === "slow-2g" || type === "2g" || type === "3g";
}

/** `linkIsConstrained` for the window this runs in. */
export function thisLinkIsConstrained(): boolean {
  if (typeof performance === "undefined" || typeof navigator === "undefined") return false;
  const downloads = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  return linkIsConstrained(
    downloads,
    (navigator as Navigator & { connection?: ConnectionHint }).connection,
  );
}

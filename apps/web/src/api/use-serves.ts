import { useSyncExternalStore } from "react";

import { useApi } from "./context";
import type { GramRpcTag } from "./served";

/**
 * The hover text of a control greyed because the server lacks its RPC. Here, not in `served.ts`,
 * which the first paint must not load.
 */
export const OLDER_SERVER = "The server runs an older Gram, which can't do this yet.";

/**
 * Whether the server serves `tag`: false for one a server older than this build lacks, so the
 * control it backs is hidden or greyed rather than failing when used.
 */
export function useServes(tag: GramRpcTag): boolean {
  const { served } = useApi();
  return useSyncExternalStore(served.subscribe, () => served.serves(tag));
}

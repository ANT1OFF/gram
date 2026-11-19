import { useSyncExternalStore } from "react";

import { useApi } from "./context";
import type { GramRpcTag } from "./served";

export { OLDER_SERVER } from "./served";

/**
 * Whether the server serves `tag`: false for one a server older than this build lacks, so the
 * control it backs is hidden or greyed rather than failing when used.
 */
export function useServes(tag: GramRpcTag): boolean {
  const { served } = useApi();
  return useSyncExternalStore(served.subscribe, () => served.serves(tag));
}

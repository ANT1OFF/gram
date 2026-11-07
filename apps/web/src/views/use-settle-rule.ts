import { settleAfterDaysOf, SETTLE_AFTER_DAYS_DEFAULT } from "@gram/contracts";
import { useMemo } from "react";

import { useNow } from "@/lib/use-now";
import { useServerSettings } from "@/settings-sync/store";

import type { SettleRule } from "./solo-threads";

/**
 * The settle rule as the user set it (Settings → General → Settle idle threads), on a clock that
 * ticks each minute: every list that leaves settled threads out reads this one, so the sidebar,
 * the rail, History and the palette agree on what has settled.
 */
export function useSettleRule(): SettleRule {
  const days = useServerSettings((s) =>
    s.settings === undefined ? SETTLE_AFTER_DAYS_DEFAULT : settleAfterDaysOf(s.settings),
  );
  // Minute resolution: a thread settles days after its last activity, not to the second.
  const now = useNow(true, undefined, 60_000);
  return useMemo(() => ({ now, days }), [now, days]);
}

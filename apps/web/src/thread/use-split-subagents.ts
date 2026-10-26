import type { GramUIMessage } from "@gram/contracts";
import { useMemo } from "react";

import { useStable } from "@/lib/use-stable";

import { sameSubagentUsage, sameSubagents, splitSubagents, type SplitMessages } from "./parts";

/**
 * `splitSubagents`, whose subagent and usage maps keep their identity while they hold the same
 * messages and snapshots: a frame that only grows the reply leaves Task rows, and the sets derived
 * from the maps, as they were.
 */
export function useSplitSubagents(messages: readonly GramUIMessage[]): SplitMessages {
  const split = useMemo(() => splitSubagents(messages), [messages]);
  const children = useStable(split.children, sameSubagents);
  const subagentUsage = useStable(split.subagentUsage, sameSubagentUsage);
  return { top: split.top, children, subagentUsage };
}

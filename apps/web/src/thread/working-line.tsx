import { useRef } from "react";

import { useNow } from "@/lib/use-now";
import { Spinner } from "@/motion/spinner";

import { WORKING_LABEL } from "./conversation-only";
import { formatElapsed } from "./subagent-strip-model";

/**
 * "Working 41s" under the last row of a transcript that shows the conversation only: its running
 * turn draws none of its calls, so this is what says the agent is at work, and for how long.
 * `since` is when the turn's prompt was sent; 0 when the prompt doesn't say, which shows no time.
 */
export function WorkingLine({ since }: { since: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true, ref);
  return (
    <div
      ref={ref}
      role="status"
      data-testid="working-line"
      className="my-3 flex items-center gap-1.5 text-reading text-foreground"
    >
      <Spinner aria-hidden className="size-icon-chip shrink-0 text-status-working" />
      {WORKING_LABEL}
      {since > 0 && (
        <span className="text-muted-foreground tabular-nums">{formatElapsed(now - since)}</span>
      )}
    </div>
  );
}

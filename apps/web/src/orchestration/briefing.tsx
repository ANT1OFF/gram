import { FEATURE_STATIONS, STATION_LABELS, type Thread } from "@gram/contracts";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { ExpandPresence, Shimmer } from "@/motion";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import { briefingOf } from "./briefing-model";
import { useFeatureCards } from "./use-feature-cards";

/** How often a shown placeholder looks again at whether it has gone stale. */
const TICK_MS = 15_000;

const PHASE_LABEL = { reading: "Reading…", briefing: "Briefing…" } as const;

/**
 * Under an orchestrator's stream: the user's latest message on its way to a feature card, shaped
 * like the card that replaces it, from the moment it is sent until that card is in. It goes when
 * the orchestrator only answers. Nothing here briefs anyone; the orchestrator decides.
 */
export function BriefingPlaceholder({ thread }: { thread: Thread }) {
  const messages = useThreadFeed(thread.id, (s) => s.messages);
  const status = useThreadsStore((s) => s.byId[thread.id]?.status);
  const cards = useFeatureCards(thread.workspaceId);
  const [now, setNow] = useState(Date.now);
  const top = useMemo(
    () => messages.filter((message) => message.metadata?.parentToolUseId === undefined),
    [messages],
  );
  const briefing = briefingOf({ messages: top, cards, status, now });
  const shown = briefing !== undefined;
  // Kept while it folds away, so the card it was keeps its words to the end.
  const [last, setLast] = useState(briefing);
  if (
    briefing !== undefined &&
    (briefing.messageId !== last?.messageId || briefing.phase !== last.phase)
  ) {
    setLast(briefing);
  }

  // A message sent after the clock last moved counts from when it was sent, never as stale; the
  // clock moves only while something shows, to let a placeholder nothing answers go.
  useEffect(() => {
    if (!shown) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [shown]);

  const current = briefing ?? last;
  return (
    <ExpandPresence open={shown}>
      {current !== undefined && (
        <div
          role="status"
          data-testid="briefing"
          data-phase={current.phase}
          aria-label={`${PHASE_LABEL[current.phase]} ${current.excerpt}`}
          className="mb-2 flex flex-col gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-medium text-foreground">{current.excerpt}</span>
            <Shimmer className="ml-auto shrink-0 text-muted-foreground">
              {PHASE_LABEL[current.phase]}
            </Shimmer>
          </div>
          <ol aria-hidden className="flex items-center gap-1 text-[0.7rem] text-muted-foreground">
            {FEATURE_STATIONS.map((station, i) => (
              <li key={station} className="flex items-center gap-1">
                {i > 0 && <span className="h-px w-3 bg-border" />}
                <span
                  className={cn(
                    "size-1.5 rounded-full border border-border",
                    i === 0 && current.phase === "briefing" && "border-primary bg-primary/40",
                  )}
                />
                {i === 0 && STATION_LABELS[station]}
              </li>
            ))}
          </ol>
        </div>
      )}
    </ExpandPresence>
  );
}

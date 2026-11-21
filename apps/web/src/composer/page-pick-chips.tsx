import type { ThreadId } from "@gram/contracts";
import { SquareMousePointer, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useArrivals } from "@/motion";
import { pickLabel, usePagePicks, usePagePicksStore, type PagePick } from "@/stores/page-picks";
import { useLayoutStore } from "@/stores/layout";

const pickFacts = (pick: PagePick) =>
  [
    `${pick.selector} on ${pick.url}`,
    `${pick.rect.width} × ${pick.rect.height} at ${pick.rect.x}, ${pick.rect.y}`,
    pick.html,
  ].join("\n");

/**
 * The elements picked in Preview waiting for the next message, one chip each, as diff comments
 * are: the element's text and selector, what the agent gets on hover. A chip opens Preview; ×
 * drops it.
 */
export function PagePickChips({ threadId, className }: { threadId: ThreadId; className?: string }) {
  const picks = usePagePicks(threadId);
  const arrivals = useArrivals(
    picks.map((pick) => pick.id),
    true,
  );
  if (picks.length === 0) return null;
  return (
    <ul aria-label="Picked elements" className={cn("flex flex-wrap gap-1", className)}>
      {picks.map((pick) => {
        const label = pickLabel(pick);
        return (
          <li
            key={pick.id}
            data-testid="page-pick-chip"
            className={cn(
              "flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border text-meta",
              arrivals.has(pick.id) && "gram-swap",
            )}
          >
            <button
              type="button"
              title={pickFacts(pick)}
              onClick={() =>
                useLayoutStore.getState().requestPanel({ threadId, panel: "preview" }, threadId)
              }
              className="flex min-w-0 items-center gap-1.5 rounded-md py-0.5 ps-1.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <SquareMousePointer aria-hidden className="size-icon-row shrink-0 text-info" />
              <span className="truncate">{label}</span>
              <span className="truncate font-mono text-muted-foreground">{pick.selector}</span>
            </button>
            <button
              type="button"
              aria-label={`Remove ${label}`}
              className="me-1.5 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => usePagePicksStore.getState().remove(threadId, pick.id)}
            >
              <X className="size-icon-row" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

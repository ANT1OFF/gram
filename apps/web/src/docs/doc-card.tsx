import type { DocCardData } from "@gram/contracts";
import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { agoText, formatStamp } from "@/lib/time";
import { useNow } from "@/lib/use-now";

import { showDoc } from "./doc-pane-store";
import { DocThumbnail } from "./doc-thumbnail";

/**
 * Where a thread published or updated a doc (`publish_doc`), in its transcript and its
 * orchestrator's chat: the doc's thumbnail, title, who and when, its opening words, and Open, which
 * shows it in the Docs tab. Local to Gram: nothing here was uploaded.
 */
export function DocCard({ card }: { card: DocCardData }) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true, ref, 60_000);
  const open = () => showDoc(card.workspaceId, card.id);
  const verb = card.action === "published" ? "Published" : "Updated";
  return (
    <div
      ref={ref}
      data-testid="doc-card"
      data-doc-id={card.id}
      data-action={card.action}
      className="my-2 flex max-w-md items-start gap-3 rounded-lg border border-edge-action bg-card px-3 py-2"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        className="mt-0.5 shrink-0 rounded-xs outline-none"
        onClick={open}
      >
        <DocThumbnail />
      </button>
      <div className="min-w-0 flex-1">
        <span className="line-clamp-2 text-body-strong">{card.title}</span>
        <span
          className="block truncate text-meta text-muted-foreground"
          title={`${verb} ${formatStamp(card.at, now)}`}
        >
          {verb} by {card.authorTitle} · {agoText(card.at, now)}
        </span>
        {card.excerpt !== "" && (
          <span className="mt-0.5 line-clamp-2 text-meta text-muted-foreground">
            {card.excerpt}
          </span>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 self-center"
        aria-label={`Open ${card.title}`}
        onClick={open}
      >
        Open
      </Button>
    </div>
  );
}

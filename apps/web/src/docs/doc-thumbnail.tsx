import { cn } from "@/lib/utils";

/**
 * A doc's thumbnail: a small page with a heading line and a few lines of text, drawn from tokens
 * rather than rendered from the doc, so it costs nothing and never shows a stale picture. The doc's
 * own words are beside it, in the card's excerpt.
 */
export function DocThumbnail({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="doc-thumbnail"
      className={cn(
        "flex h-12 w-10 shrink-0 flex-col gap-1 rounded-xs border border-edge bg-background p-1.5",
        className,
      )}
    >
      <span className="h-1 w-4/5 rounded-full bg-muted-foreground/50" />
      <span className="h-0.5 w-full rounded-full bg-muted" />
      <span className="h-0.5 w-full rounded-full bg-muted" />
      <span className="h-0.5 w-3/5 rounded-full bg-muted" />
      <span className="h-0.5 w-full rounded-full bg-muted" />
    </span>
  );
}

import { cn } from "@/lib/utils";

import { highlightSegments } from "./segments";

/** A search snippet with its matched ranges marked. */
export function Snippet({
  text,
  highlights,
  className,
}: {
  text: string;
  highlights?: readonly { start: number; end: number }[] | undefined;
  className?: string;
}) {
  return (
    <span className={cn("truncate text-xs text-muted-foreground", className)}>
      {highlightSegments(text, highlights).map((segment, i) =>
        segment.match ? (
          <mark key={i} className="rounded-xs bg-highlight/25 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

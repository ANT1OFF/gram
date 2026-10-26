import type { Label, Thread } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";

import { useApi } from "@/api/context";
import { cn } from "@/lib/utils";

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|hsl|oklch|oklab)a?\([\d\s.,%/-]+\))$/i;

/** The label's colour when it's a plain CSS colour, for tints; `undefined` for anything else. */
export const labelTint = (color: string): string | undefined =>
  COLOR.test(color.trim()) ? color.trim() : undefined;

/** The thread's label, resolved against the label list. */
export function useThreadLabel(thread: Thread | undefined): Label | undefined {
  const api = useApi();
  const { data: labels } = useQuery({ queryKey: ["labels"], queryFn: () => api.labels() });
  const id = thread?.labels[0];
  return id === undefined ? undefined : labels?.find((label) => label.id === id);
}

/**
 * The label's name as a chip with a colour dot; the name carries the meaning, never the colour alone.
 * `compact` is the sidebar row's, which already wears the colour down its edge: the dot alone, with
 * the name in the tooltip and for screen readers. A label without a plain colour keeps its name.
 */
export function LabelChip({
  label,
  testId,
  className,
  compact = false,
}: {
  label: Label;
  testId: string;
  className?: string;
  compact?: boolean;
}) {
  const tint = labelTint(label.color);
  const dotOnly = compact && tint !== undefined;
  return (
    <span
      data-testid={testId}
      title={`Label: ${label.name}`}
      className={cn(
        "flex min-w-0 shrink items-center gap-1 leading-4",
        dotOnly ? "h-4" : "rounded-full border border-border px-1.5",
        compact && "max-w-24",
        className,
      )}
    >
      {tint && (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: tint }}
        />
      )}
      <span className="sr-only">Label: </span>
      <span className={dotOnly ? "sr-only" : "truncate"}>{label.name}</span>
    </span>
  );
}

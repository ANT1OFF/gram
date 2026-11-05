import { cn } from "@/lib/utils";

/**
 * The asker's pick, said in a small outlined tag beside a choice's label. It is a note on the
 * choice, never a look of being chosen: no fill, no accent, so it can't be mistaken for a selection.
 */
export function RecommendedTag({
  testId = "ask-recommended",
  className,
}: {
  testId?: string;
  className?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-full border border-border px-1.5 align-[1px] text-caption leading-none font-normal text-muted-foreground",
        className,
      )}
    >
      Recommended
    </span>
  );
}

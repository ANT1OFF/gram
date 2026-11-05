import { cn } from "@/lib/utils";

import { CATEGORY_LABELS, type NeedsYouCategory, type NeedsYouSection } from "./needs-you-items";

// The Needs you category strip: every section with its count on one line above the list, in the
// list's order (errors and approvals first, drafts last), so a long list never hides a category
// below the fold. A pick shows that category alone; picking it again, or All (shown then), shows
// everything.

export function NeedsYouStrip({
  sections,
  category,
  onPick,
  className,
}: {
  sections: readonly NeedsYouSection[];
  category: NeedsYouCategory;
  onPick: (category: NeedsYouCategory) => void;
  className?: string;
}) {
  const total = sections.reduce((n, section) => n + section.items.length, 0);
  // A category with nothing left reads as All, as the list shows (`sectionsIn`).
  const picked = sections.some((section) => section.key === category) ? category : "all";
  const options: readonly {
    key: NeedsYouCategory;
    label: string;
    count: number;
  }[] = [
    // All only once a category is picked, as the way back: the strip stays one line.
    ...(picked === "all" ? [] : [{ key: "all" as const, label: "All", count: total }]),
    ...sections.map((section) => ({
      key: section.key,
      label: CATEGORY_LABELS[section.key],
      count: section.items.length,
    })),
  ];
  return (
    <div
      role="group"
      aria-label="Categories"
      data-testid="needs-you-strip"
      className={cn("flex flex-wrap items-center gap-0.5", className)}
    >
      {options.map(({ key, label, count }) => {
        const on = picked === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            aria-label={`${label}, ${count}`}
            data-testid="needs-you-category"
            data-category={key}
            onClick={() => onPick(on && key !== "all" ? "all" : key)}
            className={cn(
              "inline-flex h-6 items-center gap-1 rounded-(--radius-sm) px-1 text-meta outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {label}
            <span
              className={cn(
                "tabular-nums",
                // Failing is the one category in colour: it is the one that stops work.
                key === "errors" ? "text-destructive" : on ? "text-foreground/80" : undefined,
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

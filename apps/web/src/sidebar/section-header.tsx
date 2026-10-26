import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

// Every section of the sidebar draws its head here, the GitHub lists' included, so they read as one
// tier: a label in the foreground carrying the structure, and one hue carrying the meaning, in the
// icon and the count. A row's status glyph and its coloured line under the title use the same hue.

/**
 * What a section means, as the one hue it shows in. Red is left out: it only ever means failure, and
 * a section is never one.
 */
export type SectionHue =
  /** Waits on the user: Needs you, Waiting on you, Review requests. */
  | "needs"
  | "working"
  | "idle"
  | "settled"
  /** The user's own open pull requests: Open PRs, and the threads In review. */
  | "info"
  /** Curated by the user, so it carries the foreground: Pinned. */
  | "pinned"
  /** Set aside, a step quieter than the rest: Parked, a project, an empty list. */
  | "quiet";

/**
 * The icon's colour and the count's. A count is drawn on a tint of its own colour, so it takes a
 * token derived to hold its contrast there (`@gram/themes` SECTION_TINT), which neither `fg`
 * nor `fg-muted` is: the neutral hues count in `status-idle`.
 */
const HUE_TOKENS: Record<SectionHue, { icon: string; count: string }> = {
  needs: { icon: "var(--status-needs)", count: "var(--status-needs)" },
  working: { icon: "var(--status-working)", count: "var(--status-working)" },
  idle: { icon: "var(--status-idle)", count: "var(--status-idle)" },
  settled: { icon: "var(--success-text)", count: "var(--success-text)" },
  info: { icon: "var(--info-text)", count: "var(--info-text)" },
  pinned: { icon: "var(--fg)", count: "var(--status-idle)" },
  quiet: { icon: "var(--fg-muted)", count: "var(--status-idle)" },
};

/**
 * A sidebar section's head: the fold chevron, the icon in the section's hue, the label, then what the
 * caller adds (a rollup glyph, a hidden-needs mark), and the count as a pill tinted with the hue.
 * The caller wraps it in its heading element, which may hold more buttons beside it.
 */
export function SectionToggle({
  label,
  icon: Icon,
  hue,
  count,
  countTestId,
  expanded,
  children,
  className,
  style,
  ...button
}: Omit<ComponentProps<"button">, "children"> & {
  label: string;
  icon: LucideIcon;
  hue: SectionHue;
  count: number;
  countTestId: string;
  /** Absent for a head that opens something instead of folding: no chevron. */
  expanded: boolean | undefined;
  /** Between the label and the count. */
  children?: ReactNode;
}) {
  // Nothing in it is nothing to look at: the head goes quiet rather than hold a coloured zero.
  const tokens = HUE_TOKENS[count === 0 ? "quiet" : hue];
  return (
    <button
      type="button"
      aria-expanded={expanded}
      data-hue={hue}
      style={
        {
          "--section-icon": tokens.icon,
          "--section-count": tokens.count,
          ...style,
        } as CSSProperties
      }
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-sm) px-2 py-1 text-[11px] font-semibold tracking-[0.06em] text-foreground uppercase outline-none transition-colors duration-(--dur-fast) hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...button}
    >
      {expanded === undefined ? (
        <span aria-hidden className="size-3 shrink-0" />
      ) : (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-(--dur-fast)",
            expanded && "rotate-90",
          )}
        />
      )}
      <Icon aria-hidden className="size-3.5 shrink-0 text-(--section-icon)" />
      <span className="min-w-0 truncate text-left">{label}</span>
      {children}
      <span
        data-testid={countTestId}
        className="ml-auto min-w-5 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--section-count)_calc(var(--section-tint-strength)*100%),transparent)] px-1.5 text-center text-[10px] leading-4 tracking-normal text-(--section-count) tabular-nums"
      >
        {count}
      </span>
    </button>
  );
}

/**
 * A subgroup's head inside a section, such as a repository's under Review requests: a tier below
 * the section's, smaller, muted and indented, with a lighter chevron and a plain count, so it reads
 * as a label over its rows rather than a row of its own.
 */
export function SubgroupToggle({
  label,
  count,
  expanded,
  className,
  ...button
}: Omit<ComponentProps<"button">, "children"> & {
  label: string;
  count: number;
  expanded: boolean;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex w-full items-center gap-1 rounded-(--radius-sm) pt-1.5 pr-2 pb-0.5 pl-4 text-[10px] text-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...button}
    >
      <ChevronRight
        aria-hidden
        className={cn(
          "size-2.5 shrink-0 text-subtle transition-transform duration-(--dur-fast)",
          expanded && "rotate-90",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left font-mono">{label}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

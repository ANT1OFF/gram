/**
 * The count at the corner of a status glyph that shows work running under a thread, from two up.
 * Decorative: the glyph's own label names the work.
 */
export function RunningCount({ count }: { count: number | undefined }) {
  if (count === undefined || count < 2) return null;
  return (
    <span
      aria-hidden
      data-testid="running-count"
      className="pointer-events-none absolute -right-1 -bottom-0.5 text-[9px] leading-none font-medium text-status-working tabular-nums"
    >
      {count}
    </span>
  );
}

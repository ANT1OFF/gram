import { cn } from "@/lib/utils";

export type MeterTone = "neutral" | "warning" | "spent";

const TONE_FILL: Readonly<Record<MeterTone, string>> = {
  neutral: "bg-muted-foreground",
  warning: "bg-warning",
  spent: "bg-destructive",
};

/** A share's colour when nothing else decides it: amber from 90%, red once it is all used. */
export const meterTone = (value: number): MeterTone =>
  value >= 1 ? "spent" : value >= 0.9 ? "warning" : "neutral";

/**
 * A thin track whose fill glides to each new reading: how much of something is used, from 0 to 1.
 * With a `label` it is a meter a screen reader reads; without one it is decoration beside words
 * that already say the number.
 */
export function Meter({
  value,
  tone = meterTone(value),
  label,
  className,
  fillTestId,
}: {
  /** The share used, 0 to 1; anything past either end is drawn at that end. */
  value: number;
  /** Its colour; from the value unless given. */
  tone?: MeterTone;
  /** What is measured, for a screen reader. Left out, the meter is hidden from one. */
  label?: string;
  className?: string;
  fillTestId?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
  return (
    <span
      {...(label === undefined
        ? { "aria-hidden": true }
        : {
            role: "meter",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": percent,
          })}
      data-slot="meter"
      data-tone={tone}
      className={cn("block h-1 shrink-0 overflow-hidden rounded-full bg-foreground/15", className)}
    >
      <span
        data-testid={fillTestId}
        className={cn(
          "block h-full rounded-full transition-[width] duration-(--dur-move-base) ease-(--ease-spring)",
          TONE_FILL[tone],
        )}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

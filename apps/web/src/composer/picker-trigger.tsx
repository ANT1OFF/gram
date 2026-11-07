import { useState, type ComponentProps, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PulseOnce } from "@/motion";

import type { LabelSize } from "./toolbar-layout";

/** `labelled` as a size: `true` is the value in full, `false` the glyph alone. */
export const labelSize = (labelled: boolean | LabelSize): LabelSize =>
  labelled === true ? "full" : labelled === false ? "icon" : labelled;

/**
 * The value's words on a toolbar trigger: in full, or in `compact` form when the row is short of
 * room. Both are always there to be measured (`useToolbarLayout`); the one not showing is hidden,
 * the full one still read by screen readers. With a `dimension` the words say what the value is of,
 * "Effort: Extra high", so a chip never reads as another's ("Model default" beside the model
 * picker); short of room, "Effort: X-high", or the dimension alone when `compact` is it or empty
 * (a default, whose value is on hover).
 */
export function ValueWords({
  value,
  compact,
  labelled,
  dimension,
}: {
  value: string;
  compact?: string | undefined;
  labelled: boolean | LabelSize;
  dimension?: string | undefined;
}) {
  const size = labelSize(labelled);
  const fullText = dimension === undefined ? value : `${dimension}: ${value}`;
  const shortText =
    compact === undefined || dimension === undefined
      ? compact
      : compact === "" || compact === dimension
        ? dimension
        : `${dimension}: ${compact}`;
  const distinct = shortText !== undefined && shortText !== fullText;
  const full = size === "full" || (size === "short" && !distinct);
  // The dimension reads a step quieter than its value, so the eye lands on what is chosen.
  const prefix = dimension === undefined ? undefined : `${dimension}: `;
  const words = (text: string) =>
    prefix === undefined || !text.startsWith(prefix) ? (
      text
    ) : (
      <>
        <span data-toolbar-dimension className="font-normal">
          {dimension}:
        </span>{" "}
        {text.slice(prefix.length)}
      </>
    );
  return (
    <>
      <span data-toolbar-label className={cn("min-w-0 truncate", !full && "sr-only")}>
        {words(fullText)}
      </span>
      {shortText !== undefined && distinct && (
        <span
          aria-hidden
          data-toolbar-compact
          className={cn("min-w-0 truncate", size !== "short" && "sr-only")}
        >
          {words(shortText)}
        </span>
      )}
    </>
  );
}

/**
 * Confirms a pick once it lands: `pick` notes the value chosen, and `landed` counts each time the
 * shown value then turns into it. A value that changes any other way (another thread's in the same
 * composer, the server's own) doesn't count, so only the user's own choice pulses.
 */
export function usePickConfirm(value: string | undefined) {
  const [pending, setPending] = useState<string>();
  const [landed, setLanded] = useState(0);
  if (pending !== undefined && pending === value) {
    // Derived during render, as React asks for state that follows a prop.
    setPending(undefined);
    setLanded(landed + 1);
  }
  return { landed, pick: setPending };
}

/**
 * A select's trigger. On a toolbar (the thread's composer and the new-thread prompt box) it says
 * what it picks and the chosen value when `labelled`, without a glyph: "Effort: Extra high", "Mode:
 * Plan", so a value never reads as another control's. Short of room it says the value in `compact`
 * form ("Effort: X-high", or "Effort" alone for a default), and only at the narrowest gives way to
 * its glyph alone (`useToolbarLayout`); either way the trigger's name and its tooltip say both,
 * "Effort: Extra high", with the shortcut. As a form's `field` it names what it picks and shows the
 * value in full.
 */
export function PickerTrigger({
  label,
  value,
  words,
  compact,
  labelled,
  field = false,
  icon,
  title,
  tip,
  confirm,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, "children" | "title"> & {
  /** What the picker picks: "Effort", "Mode". */
  label: string;
  /** The chosen value in short: the toolbar's text, and named after `label`. */
  value: string;
  /** The value's words on the trigger when they differ from `value`, which names it: "Default". */
  words?: string | undefined;
  /** The value in three to six letters, for a row short of room: "X-high", "Edits". */
  compact?: string | undefined;
  /**
   * How much of the value shows beside the glyph: `true` or "full" the whole of it, "short" its
   * `compact` form, `false` or "icon" none, the glyph standing alone.
   */
  labelled: boolean | LabelSize;
  /** A form's select: named `label`, with the full value from the list in the trigger. */
  field?: boolean;
  icon?: ReactNode;
  /** The field's native title. */
  title?: string | undefined;
  /** The tooltip, when it says more than "Label: value", such as a shortcut or a warning. */
  tip?: string | undefined;
  /** `usePickConfirm`'s count: each rise rings the glyph once, so a pick shows it took. */
  confirm?: number | undefined;
}) {
  const glyph =
    icon &&
    (confirm === undefined ? (
      icon
    ) : (
      <PulseOnce trigger={confirm} when={confirm > 0}>
        {icon}
      </PulseOnce>
    ));
  if (field)
    return (
      <SelectTrigger aria-label={label} title={title} {...props}>
        {glyph}
        <SelectValue placeholder={label} />
      </SelectTrigger>
    );
  const named = `${label}: ${value}`;
  const size = labelSize(labelled);
  // Short of room its chevron goes, leaving the space to the words (`useToolbarLayout`).
  const bare = size !== "full";
  return (
    // A native title would wait a second before saying what the glyph means.
    <Hint
      label={tip ?? named}
      render={
        <SelectTrigger
          aria-label={named}
          {...props}
          className={cn(props.className, bare && "[&>svg:last-child]:hidden")}
        />
      }
    >
      {/* The glyph stands in for the words, never beside them: "Effort: High" says what a gauge
          only hints at, so it draws only once the words give way. `useToolbarLayout` counts it as
          `GLYPH` while it isn't drawn. */}
      {glyph && (
        <span data-toolbar-glyph className={size === "icon" ? "contents" : "hidden"}>
          {glyph}
        </span>
      )}
      {/* Measured by `useToolbarLayout`, hidden or not, to know what showing it would take. */}
      <ValueWords value={words ?? value} compact={compact} labelled={labelled} dimension={label} />
    </Hint>
  );
}

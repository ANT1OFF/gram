import { useState, type ComponentProps, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PulseOnce } from "@/motion";

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
 * A select's trigger. On a toolbar (the thread's composer and the new-thread prompt box) it is its
 * glyph, then the chosen value in a word or two when `labelled`: "Extra high", "Plan". The value
 * gives way to the glyph alone when the row runs short (`useToolbarLayout`), and either way the
 * trigger's name and its tooltip say both, "Effort: Extra high", with the shortcut. As a form's
 * `field` it names what it picks and shows the value in full.
 */
export function PickerTrigger({
  label,
  value,
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
  /** Shows `value` beside the glyph; without it the glyph stands alone. */
  labelled: boolean;
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
  return (
    // A native title would wait a second before saying what the glyph means.
    <Hint label={tip ?? named} render={<SelectTrigger aria-label={named} {...props} />}>
      {glyph}
      {/* Measured by `useToolbarLayout`, hidden or not, to know what showing it would take. */}
      <span data-toolbar-label className={cn("min-w-0 truncate", !labelled && "sr-only")}>
        {value}
      </span>
    </Hint>
  );
}

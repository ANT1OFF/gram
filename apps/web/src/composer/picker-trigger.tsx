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
 * A toolbar select's trigger: its glyph, then the value when `labelled`. Without the label the glyph
 * stands alone, so its name says the value ("Mode: Bypass") and a tooltip says it the moment it is
 * hovered; the value stays in the trigger for screen readers, and the open list spells out every
 * option. Shared by the thread's composer and the new-thread draft so both read alike.
 */
export function PickerTrigger({
  label,
  value,
  labelled,
  icon,
  title,
  tip,
  confirm,
  ...props
}: Omit<ComponentProps<typeof SelectTrigger>, "children" | "title"> & {
  /** What the picker picks: the trigger's name while labelled. */
  label: string;
  /** The words for the chosen value, named after `label` while the glyph stands alone. */
  value: string;
  labelled: boolean;
  icon?: ReactNode;
  /** The labelled trigger's native title. */
  title?: string | undefined;
  /** The glyph's tooltip, when it says more than its name, such as a shortcut or a warning. */
  tip?: string | undefined;
  /** `usePickConfirm`'s count: each rise rings the glyph once, so a pick shows it took. */
  confirm?: number | undefined;
}) {
  const glyph = (
    <>
      {icon &&
        (confirm === undefined ? (
          icon
        ) : (
          <PulseOnce trigger={confirm} when={confirm > 0}>
            {icon}
          </PulseOnce>
        ))}
      <SelectValue data-toolbar-label placeholder={label} className={cn(!labelled && "sr-only")} />
    </>
  );
  if (labelled)
    return (
      <SelectTrigger aria-label={label} title={title} {...props}>
        {glyph}
      </SelectTrigger>
    );
  const named = `${label}: ${value}`;
  return (
    // A native title would wait a second before saying what the glyph means.
    <Hint label={tip ?? named} render={<SelectTrigger aria-label={named} {...props} />}>
      {glyph}
    </Hint>
  );
}

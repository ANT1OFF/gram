import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The box itself, as Gram's dialogs and Settings draw a native checkbox or radio: 14 px, in the
 * accent once ticked, and the focus ring only for the keyboard.
 */
const BOX = "size-3.5 shrink-0 accent-primary outline-none focus-visible:focus-ring";

/**
 * A choice's words: its name, and one muted line under it on what ticking it does. The name is UI
 * text (`text-body`) unless the row's `className` gives another step; the box sits on the name's
 * first line (`h-lh`) at any of them.
 */
function ChoiceLabel({
  label,
  description,
  className,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 text-body has-disabled:cursor-not-allowed has-disabled:opacity-50",
        className,
      )}
    >
      <span className="flex h-lh shrink-0 items-center">{children}</span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        {description !== undefined && (
          <span className="text-meta text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
}

/**
 * A checkbox with its name, and an optional line under it on what it does, for a choice that stands
 * alone ("Also delete the worktree on disk"). A native input, so it takes part in a form and every
 * input prop (`checked`, `onChange`, `name`, `disabled`, `data-testid`) goes to it; `className` is
 * the row's. Without a `label` it is the bare box, named by its `aria-label`.
 */
export function Checkbox({
  label,
  description,
  className,
  ...props
}: Omit<ComponentProps<"input">, "type" | "children"> & {
  label?: ReactNode;
  description?: ReactNode;
}) {
  if (label === undefined)
    return <input type="checkbox" data-slot="checkbox" className={cn(BOX, className)} {...props} />;
  return (
    <ChoiceLabel label={label} description={description} className={className}>
      <input type="checkbox" data-slot="checkbox" className={BOX} {...props} />
    </ChoiceLabel>
  );
}

/** One of a `RadioGroup`'s choices: its value, its name and an optional line under it. */
export interface RadioOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly disabled?: boolean;
}

/**
 * One choice out of a list, as a column of radio buttons, each with an optional line on what it
 * does: for choices that need their sentence read (a worker's mode). For two to four short words
 * on one line, `OptionGroup` is the segmented control. `label` names the group for a screen reader;
 * the row or field it sits in shows it.
 */
export function RadioGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  name,
  className,
  testId,
}: {
  label: string;
  options: readonly RadioOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** The inputs' shared name, for a form; one of the group's own otherwise. */
  name?: string;
  className?: string;
  testId?: string;
}) {
  const own = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-testid={testId}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {options.map((option) => (
        <ChoiceLabel key={option.value} label={option.label} description={option.description}>
          <input
            type="radio"
            data-slot="radio"
            name={name ?? own}
            value={option.value}
            className={BOX}
            checked={option.value === value}
            disabled={disabled || option.disabled === true}
            onChange={() => onChange(option.value)}
          />
        </ChoiceLabel>
      ))}
    </div>
  );
}

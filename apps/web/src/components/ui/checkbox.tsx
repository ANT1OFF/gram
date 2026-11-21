import { useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

const BOX = "size-3.5 shrink-0 accent-primary outline-none focus-visible:focus-ring";

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
        "group/choice flex cursor-pointer items-start gap-2 text-body has-disabled:cursor-not-allowed",
        className,
      )}
    >
      <span className="flex h-lh shrink-0 items-center">{children}</span>
      <span className="flex min-w-0 flex-col gap-0.5 group-has-disabled/choice:opacity-50">
        <span>{label}</span>
        {description !== undefined && (
          <span className="text-meta text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
}

type CheckboxProps = Omit<ComponentProps<"input">, "type" | "children"> & {
  onCheckedChange?: (checked: boolean) => void;
} & (
    | { label: ReactNode; description?: ReactNode }
    | { label?: undefined; description?: undefined }
  );

/**
 * A checkbox with its name, and an optional line under it on what it does, for a choice that stands
 * alone ("Also delete the worktree on disk"). A native input, so it takes part in a form and every
 * input prop (`checked`, `onChange`, `name`, `disabled`, `data-testid`) goes to it; `className` is
 * the row's. `onCheckedChange` gives the new state, as `Switch` and `Toggle` do. Without a `label`
 * it is the bare box, named by its `aria-label`, and takes no description.
 */
export function Checkbox({
  label,
  description,
  className,
  onChange,
  onCheckedChange,
  ...props
}: CheckboxProps) {
  const handle: ComponentProps<"input">["onChange"] =
    onCheckedChange === undefined
      ? onChange
      : (event) => {
          onChange?.(event);
          onCheckedChange(event.target.checked);
        };
  if (label === undefined)
    return (
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(BOX, className)}
        onChange={handle}
        {...props}
      />
    );
  return (
    <ChoiceLabel label={label} description={description} className={className}>
      <input type="checkbox" data-slot="checkbox" className={BOX} onChange={handle} {...props} />
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
 * on one line, `OptionGroup` is the segmented control. The group is named by `label` (for a screen
 * reader; the row or field it sits in shows it), or by the visible heading `labelledBy` names.
 * Native radios: Tab enters at the checked one and the arrow keys move and pick.
 */
export function RadioGroup<T extends string>({
  label,
  labelledBy,
  options,
  value,
  onChange,
  disabled = false,
  name,
  autoFocusFirst = false,
  className,
  testId,
}: {
  label?: string;
  /** The id of a visible heading that names the group, in place of `label`. */
  labelledBy?: string;
  options: readonly RadioOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** The inputs' shared name, for a form; one of the group's own otherwise. */
  name?: string;
  /** Marks the first choice as where focus goes when the step or dialog around it opens. */
  autoFocusFirst?: boolean;
  className?: string;
  testId?: string;
}) {
  const own = useId();
  return (
    <div
      role="radiogroup"
      {...(labelledBy === undefined ? { "aria-label": label } : { "aria-labelledby": labelledBy })}
      data-testid={testId}
      className={cn("flex flex-col gap-1.5", className)}
    >
      {options.map((option, index) => (
        <ChoiceLabel key={option.value} label={option.label} description={option.description}>
          <input
            type="radio"
            data-slot="radio"
            name={name ?? own}
            value={option.value}
            className={BOX}
            {...(autoFocusFirst && index === 0 ? { "data-autofocus": true } : {})}
            checked={option.value === value}
            disabled={disabled || option.disabled === true}
            onChange={() => onChange(option.value)}
          />
        </ChoiceLabel>
      ))}
    </div>
  );
}

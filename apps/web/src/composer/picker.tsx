import { useRef, useState, type ReactNode } from "react";

import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";

import { aboveComposer } from "./above-composer";
import { PickerTrigger, usePickConfirm, type LabelSize } from "./picker-trigger";
import { GHOST_TRIGGER } from "./styles";

export interface PickerOption<V extends string> {
  value: V;
  label: string;
  /** The value on the toolbar's trigger and in its tooltip, when shorter than `label`. */
  short?: string | undefined;
  /**
   * The value's words on the trigger, when even shorter than `short`, which its name and tooltip
   * keep: "Effort: Default" on the chip, "Effort: Model default" on hover.
   */
  word?: string | undefined;
  /**
   * The value in three to six letters, for a toolbar short of room for `short`: "High", "Ask",
   * "Opus". The tooltip and name still say `short`.
   */
  compact?: string | undefined;
  /** A line under the label: the model picker's search list, and each mode's consequence. */
  description?: string | undefined;
  /** The model picker's section past favourites: the agent or gateway it runs on, or Custom. */
  group?: string | undefined;
  /** The model picker's mark beside the row, for a list of more than one agent's models. */
  icon?: ReactNode;
  /** Greyed, and can't be picked; why is said where the list says it (a group's heading). */
  disabled?: boolean | undefined;
  /**
   * A pick opens something to confirm rather than setting the value, as another agent's model
   * opens "Continue in Codex": it is never the current value, and has no star.
   */
  opens?: boolean | undefined;
  /**
   * A newer model of its family is listed (`supersededModels`): the model picker folds it under
   * Legacy models, and shows it with the rest while a search or a star finds it.
   */
  legacy?: boolean | undefined;
}

interface PickerProps<V extends string> {
  label: string;
  shortcutId: string;
  keys: string;
  value: V | undefined;
  options: readonly PickerOption<V>[];
  onChange: (value: V) => void;
  focused: boolean;
  warning?: string | undefined;
  icon?: ReactNode;
  iconLabel?: string | undefined;
  labelled?: boolean | LabelSize;
  field?: boolean;
  onOpen?: (() => void) | undefined;
}

/** A compact select, opened with its shortcut: a settings form's field, or a glyph and its value. */
export function Picker<V extends string>({
  label,
  shortcutId,
  keys,
  value,
  options,
  onChange,
  focused,
  warning,
  icon,
  iconLabel,
  labelled = true,
  field = false,
  onOpen,
}: PickerProps<V>) {
  const [open, setOpenState] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const setOpen = (next: boolean) => {
    if (next) onOpen?.();
    setOpenState(next);
  };
  const hint = useShortcutHint(shortcutId);
  const confirm = usePickConfirm(value);
  useShortcut(
    {
      id: shortcutId,
      keys,
      label: `Pick ${label.toLowerCase()}`,
      group: "Composer",
      run: () => setOpen(true),
    },
    focused && options.length > 0,
  );

  const chosen = options.find((option) => option.value === value);
  const shown = chosen?.short ?? chosen?.label ?? "none";
  const named = field ? label : `${label}: ${shown}`;
  const tagged = withHint(named, hint);
  const title = warning ?? (iconLabel === undefined ? tagged : `${iconLabel} · ${tagged}`);
  const description = [iconLabel, warning].filter(Boolean).join(". ") || undefined;
  const tip = [iconLabel === undefined ? tagged : `${iconLabel} · ${tagged}`, warning]
    .filter(Boolean)
    .join("\n");

  return (
    <Select
      value={value ?? null}
      items={options}
      open={open}
      onOpenChange={(next) => setOpen(next)}
      onValueChange={(next) => {
        if (next === null) return;
        confirm.pick(next);
        onChange(next as V);
      }}
    >
      <PickerTrigger
        ref={trigger}
        size="sm"
        label={label}
        value={shown}
        words={chosen?.word}
        compact={chosen?.compact}
        labelled={labelled}
        field={field}
        icon={icon && <Swap swapKey={String(value)}>{icon}</Swap>}
        confirm={confirm.landed}
        title={title}
        tip={tip}
        aria-description={description}
        data-warning={warning ? "true" : undefined}
        className={cn(GHOST_TRIGGER, warning && "text-warning hover:text-warning")}
      />
      <SelectContent side="top" anchor={() => aboveComposer(trigger.current)}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} description={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

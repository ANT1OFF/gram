import { useRef, useState, type ReactNode } from "react";

import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";

import { aboveComposer } from "./above-composer";
import { PickerTrigger, usePickConfirm } from "./picker-trigger";
import { GHOST_TRIGGER } from "./styles";
import type { LabelSize } from "./toolbar-layout";

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
}

interface PickerProps<V extends string> {
  label: string;
  shortcutId: string;
  keys: string;
  value: V | undefined;
  options: readonly PickerOption<V>[];
  onChange: (value: V) => void;
  /** Registers the opening shortcut only for the focused pane. */
  focused: boolean;
  /**
   * Tints the trigger with the warning colour (a caution on a setting, such as Bypass, not "needs
   * you") and explains why in its tooltip.
   */
  warning?: string | undefined;
  /** A glyph before the value, such as the agent the model runs on. */
  icon?: ReactNode;
  /** What `icon` stands for, in the tooltip and read after the label. */
  iconLabel?: string | undefined;
  /**
   * Shows the value beside the glyph, in short for effort and mode ("Extra high"), or with "short"
   * in its compact form ("X-high"). Without it the glyph stands alone; either way its name and
   * tooltip say the value ("Mode: Bypass"), and the open list spells out every option with the
   * current one checked.
   */
  labelled?: boolean | LabelSize;
  /**
   * A settings form's select rather than a toolbar control: named by its label alone, the value in
   * full, and its shortcut in a native title.
   */
  field?: boolean;
  /** Called as the list opens, by click or shortcut. */
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
  // Effort and mode in a word or two, the same on the trigger as in its tooltip ("Effort: Extra
  // high").
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
      {/* Above the whole composer, so the list never covers the draft. */}
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

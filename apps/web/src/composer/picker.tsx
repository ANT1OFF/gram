import { useState, type ReactNode } from "react";

import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";

import { ModelCombobox } from "./model-picker";
import { PickerTrigger, usePickConfirm } from "./picker-trigger";
import { GHOST_TRIGGER } from "./styles";

export interface PickerOption<V extends string> {
  value: V;
  label: string;
  /** The value on the toolbar's trigger and in its tooltip, when shorter than `label`. */
  short?: string | undefined;
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
   * Shows the value beside the glyph, in short for effort and mode ("Extra high"). Without it the
   * glyph stands alone; either way its name and tooltip say the value ("Mode: Bypass"), and the open
   * list spells out every option with the current one checked.
   */
  labelled?: boolean;
  /**
   * A settings form's select rather than a toolbar control: named by its label alone, the value in
   * full, and its shortcut in a native title.
   */
  field?: boolean;
  /** Moved into the toolbar's "…" menu: nothing renders, and the shortcut calls `onFoldedOpen`. */
  folded?: boolean;
  onFoldedOpen?: (() => void) | undefined;
  /** Called as the list opens, by click or shortcut. */
  onOpen?: (() => void) | undefined;
  /** A searchable list with favourites, grouped by agent or gateway, instead of a select. */
  search?:
    | {
        rowIcon: ReactNode;
        favourite: (value: string) => boolean;
        onToggleFavourite: (value: string) => void;
      }
    | undefined;
}

/** A compact select for the composer toolbar, opened with its shortcut; a glyph alone when narrow. */
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
  folded = false,
  onFoldedOpen,
  onOpen,
  search,
}: PickerProps<V>) {
  const [open, setOpenState] = useState(false);
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
      run: () => (folded ? onFoldedOpen?.() : setOpen(true)),
    },
    focused && options.length > 0,
  );

  if (folded) return null;
  const chosen = options.find((option) => option.value === value);
  // The model's name in full; effort and mode in a word or two, the same on the trigger as in its
  // tooltip ("Effort: Extra high").
  const shown = chosen?.short ?? chosen?.label ?? "none";
  const named = field ? label : `${label}: ${shown}`;
  const tagged = withHint(named, hint);
  const title = warning ?? (iconLabel === undefined ? tagged : `${iconLabel} · ${tagged}`);
  const description = [iconLabel, warning].filter(Boolean).join(". ") || undefined;
  const tip = [iconLabel === undefined ? tagged : `${iconLabel} · ${tagged}`, warning]
    .filter(Boolean)
    .join("\n");

  if (search) {
    return (
      <ModelCombobox
        label={label}
        value={value}
        options={options}
        onChange={(next) => onChange(next as V)}
        open={open}
        onOpenChange={setOpen}
        icon={icon}
        title={title}
        description={description}
        warning={warning}
        labelled={labelled}
        tip={tip}
        {...search}
      />
    );
  }

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
        size="sm"
        label={label}
        value={shown}
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
      <SelectContent side="top">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} description={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

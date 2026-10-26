import { useState, type ReactNode } from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useShortcut } from "@/keyboard/registry";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { Swap } from "@/motion";

import { ModelCombobox } from "./model-picker";
import { MODEL_SEARCH_THRESHOLD } from "./models";
import { GHOST_TRIGGER } from "./styles";

export interface PickerOption<V extends string> {
  value: V;
  label: string;
  /** A line under the label where the list has room for one: the model picker's search list. */
  description?: string | undefined;
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
  /** Tints the trigger amber and explains why in its tooltip. */
  warning?: string | undefined;
  /** A glyph before the value, such as the agent the model runs on. */
  icon?: ReactNode;
  /** What `icon` stands for, in the tooltip and read after the label. */
  iconLabel?: string | undefined;
  /** Shows the value beside the glyph; without it the tooltip names the value instead. */
  labelled?: boolean;
  /** Moved into the toolbar's "…" menu: nothing renders, and the shortcut calls `onFoldedOpen`. */
  folded?: boolean;
  onFoldedOpen?: (() => void) | undefined;
  /** Called as the list opens, by click or shortcut. */
  onOpen?: (() => void) | undefined;
  /** Past `MODEL_SEARCH_THRESHOLD` options, a searchable list with favourites instead of a select. */
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
  const named = labelled
    ? label
    : `${label}: ${options.find((option) => option.value === value)?.label ?? "none"}`;
  const title =
    warning ??
    (iconLabel === undefined ? withHint(named, hint) : `${iconLabel} · ${withHint(named, hint)}`);
  const description = [iconLabel, warning].filter(Boolean).join(". ") || undefined;

  if (search && options.length > MODEL_SEARCH_THRESHOLD) {
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
        if (next !== null) onChange(next as V);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        aria-description={description}
        title={title}
        data-warning={warning ? "true" : undefined}
        className={cn(GHOST_TRIGGER, warning && "text-status-needs hover:text-status-needs")}
      >
        {icon && <Swap swapKey={String(value)}>{icon}</Swap>}
        <SelectValue
          data-toolbar-label
          placeholder={label}
          className={cn(!labelled && "sr-only")}
        />
      </SelectTrigger>
      <SelectContent side="top">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} title={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

import { cn } from "@/lib/utils";

import { shortcutHint } from "./bindings";
import { useBindingsStore } from "./bindings-store";

/** A shortcut's keys as shown to the user, following `keybindings.json`; "" when turned off. */
export function useShortcutHint(id: string): string {
  const overrides = useBindingsStore((s) => s.overrides);
  return shortcutHint(id, overrides);
}

/** `label (keys)`, or just `label` for a shortcut that's turned off. */
export const withHint = (label: string, hint: string): string =>
  hint ? `${label} (${hint})` : label;

/**
 * A key cap inside a button or beside a choice: the button's own text colour at full strength, in a
 * hairline outline of it, so the hint reads on a primary fill as well as on a ghost button.
 */
export const KEY_CAP =
  "inline-flex items-center rounded-2xs border border-current/40 px-1 font-mono text-caption leading-4";

/**
 * A shortcut's keys as a `<kbd>`; nothing for a shortcut that's turned off. `cap` draws it as a key
 * cap, for a hint inside a button.
 */
export function ShortcutKbd({
  id,
  className,
  cap = false,
}: {
  id: string;
  className?: string;
  cap?: boolean;
}) {
  const hint = useShortcutHint(id);
  if (!hint) return null;
  return <kbd className={cn("font-mono text-caption", cap && KEY_CAP, className)}>{hint}</kbd>;
}

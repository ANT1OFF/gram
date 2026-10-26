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

/** A shortcut's keys as a `<kbd>`; nothing for a shortcut that's turned off. */
export function ShortcutKbd({ id, className }: { id: string; className?: string }) {
  const hint = useShortcutHint(id);
  if (!hint) return null;
  return <kbd className={cn("font-mono text-[10px]", className)}>{hint}</kbd>;
}

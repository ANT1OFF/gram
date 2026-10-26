import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A small on/off `role="switch"` button; `label` is its accessible name. */
export function ToggleSwitch({
  on,
  label,
  disabled,
  onToggle,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        on ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-3 rounded-full bg-background shadow transition-transform",
          on ? "translate-x-3" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/**
 * A `role="switch"` pill with its name written on it, for a row of switches that has no room for a
 * label beside each. `label` is the accessible name; `children` is the short visible word.
 */
export function TogglePill({
  on,
  label,
  disabled,
  title,
  onToggle,
  children,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  title?: string;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border bg-background px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        on
          ? "border-primary text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full transition-colors", on ? "bg-primary" : "bg-border")}
      />
      {children}
    </button>
  );
}

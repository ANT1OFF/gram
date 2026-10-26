import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";

/** One of the title bar's icon toggles, its shortcut in its tooltip. */
export function ShellToggle({
  icon: Icon,
  label,
  shortcutId,
  pressed,
  testId,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  shortcutId: string;
  /** Absent for a button that only does one thing, and goes once it has. */
  pressed?: boolean;
  testId?: string;
  onClick: () => void;
}) {
  const hint = useShortcutHint(shortcutId);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      title={withHint(label, hint)}
      className="text-muted-foreground [-webkit-app-region:no-drag] aria-pressed:text-foreground"
      onClick={onClick}
    >
      <Icon />
    </Button>
  );
}

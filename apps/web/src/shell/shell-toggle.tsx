import type { LucideIcon } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";

/** One of the title bar's icon toggles, its name and shortcut in its tooltip. */
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
    <Hint
      label={withHint(label, hint)}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          data-testid={testId}
          className="text-muted-foreground [-webkit-app-region:no-drag] aria-pressed:text-foreground"
          onClick={onClick}
        />
      }
    >
      <Icon />
    </Hint>
  );
}

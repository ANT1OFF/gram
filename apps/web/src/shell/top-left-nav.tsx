import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { useLaunchIssues } from "@/launch-checks/banner";
import { UpdatePill } from "@/updates/update-pill";
import { cn } from "@/lib/utils";

const NAV =
  "relative text-muted-foreground [-webkit-app-region:no-drag] data-[status=active]:bg-sidebar-row-active data-[status=active]:text-foreground";

/**
 * Settings as an icon, once in the window: at the open overview's foot beside History, at the top
 * of the compact rail, and at the title bar's left while the overview is hidden (the test id keeps
 * the name of where it began). Usage has its one way in at the title bar's meter. Settings carries
 * a neutral dot while a setup problem the user dismissed from the banner still stands (gh signed
 * out, say): its hint names the problem and it opens Diagnostics, where the problem is in full. A
 * signed install's update pill comes first while there's an update to tell about, unless the caller
 * (the open overview, whose header keeps it at the top) shows it elsewhere.
 */
export function TopLeftNav({
  className,
  update = true,
}: {
  className?: string;
  /** The update pill before Settings; off where the caller shows it itself. */
  update?: boolean;
}) {
  const settingsHint = useShortcutHint("settings.open");
  const setup = useLaunchIssues().dismissed;
  const settingsLabel =
    setup.length === 0
      ? withHint("Settings", settingsHint)
      : `${withHint("Settings", settingsHint)}\n${setup.map((issue) => issue.text.replaceAll("`", "")).join("\n")}\nOpens Diagnostics`;
  return (
    <div
      role="group"
      aria-label="Navigation"
      data-testid="top-left-nav"
      className={cn("flex items-center gap-1", className)}
    >
      {update && <UpdatePill size="xs" />}
      <Hint
        label={settingsLabel}
        side="bottom"
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              setup.length === 0
                ? "Settings"
                : `Settings, ${setup.length === 1 ? "1 setup problem" : `${setup.length} setup problems`}`
            }
            data-setup={setup.length > 0 || undefined}
            className={NAV}
            render={<Link to={setup.length === 0 ? "/settings" : "/settings/diagnostics"} />}
            nativeButton={false}
          />
        }
      >
        <Settings aria-hidden />
        {setup.length > 0 && (
          <span
            aria-hidden
            data-testid="top-left-settings-dot"
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-foreground"
          />
        )}
      </Hint>
    </div>
  );
}

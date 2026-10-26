import { Link } from "@tanstack/react-router";
import { ChartNoAxesCombined, Settings } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { UpdatePill } from "@/updates/update-pill";
import { cn } from "@/lib/utils";
import { limitWarns, tightestLimit, useUsageLimits } from "@/stores/usage-limits";
import { limitSummaryText } from "@/usage/limit-format";

import { useLimitsNow } from "./usage-meter";

const NAV =
  "relative text-muted-foreground [-webkit-app-region:no-drag] data-[status=active]:bg-sidebar-row-active data-[status=active]:text-foreground";

/**
 * Usage and Settings as two icons at the window's top left: in the overview's header while it is
 * shown, in the title bar while it is hidden. Usage carries a dot once a subscription window is
 * nearly used, and its hint names the tightest one. A signed install's update pill comes first
 * while there's an update to tell about.
 */
export function TopLeftNav({ className }: { className?: string }) {
  const settingsHint = useShortcutHint("settings.open");
  const limits = useUsageLimits((s) => s.limits);
  const now = useLimitsNow(limits);
  const tightest = tightestLimit(limits, now);
  const warns = tightest !== undefined && limitWarns(tightest.limit);
  const reading = tightest === undefined ? undefined : limitSummaryText(tightest);
  return (
    <div
      role="group"
      aria-label="Navigation"
      data-testid="top-left-nav"
      className={cn("flex items-center gap-1", className)}
    >
      <UpdatePill size="xs" />
      <Hint
        label={reading === undefined ? "Usage" : `Usage\n${reading}`}
        side="bottom"
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Usage"
            data-warn={warns || undefined}
            className={NAV}
            render={<Link to="/usage" />}
            nativeButton={false}
          />
        }
      >
        <ChartNoAxesCombined aria-hidden />
        {warns && (
          <span
            aria-hidden
            data-testid="top-left-usage-dot"
            className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning"
          />
        )}
      </Hint>
      <Hint
        label={withHint("Settings", settingsHint)}
        side="bottom"
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Settings"
            className={NAV}
            render={<Link to="/settings" />}
            nativeButton={false}
          />
        }
      >
        <Settings aria-hidden />
      </Hint>
    </div>
  );
}

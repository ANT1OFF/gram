import type { Autonomy } from "@gram/contracts";
import { Shield, ShieldAlert, ShieldCheck, ShieldHalf, type LucideIcon } from "lucide-react";

import { createElement } from "react";

import { cn } from "@/lib/utils";
import { presentAutonomy } from "@/settings/workspace-settings-model";
import { known } from "@/thread/orchestration-model";

/** A shape per level as well as a tone, so `full` never reads by colour alone. */
export const AUTONOMY_ICON: Record<Autonomy, LucideIcon> = {
  supervised: ShieldCheck,
  publish: ShieldHalf,
  full: ShieldAlert,
};

/** A workspace's autonomy as a small chip whose tooltip is the level's sentence from Settings. */
export function AutonomyChip({
  autonomy,
  testId = "autonomy-chip",
  className,
}: {
  autonomy: Autonomy;
  testId?: string;
  className?: string;
}) {
  const level = presentAutonomy(autonomy);
  const icon = known(AUTONOMY_ICON, autonomy) ?? Shield;
  return (
    <span
      data-testid={testId}
      data-autonomy={autonomy}
      title={`${level.label} autonomy. ${level.description}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-sm border px-1 text-xs font-normal transition-colors duration-(--dur-base)",
        level.warn ? "border-warning/50 text-warning" : "border-border text-muted-foreground",
        className,
      )}
    >
      {createElement(icon, { "aria-hidden": true, className: "size-3 shrink-0" })}
      {level.label}
    </span>
  );
}

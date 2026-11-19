import { cn } from "@/lib/utils";
import { OverviewRail } from "@/orchestration/overview-rail";
import { OverviewSidebar } from "@/orchestration/overview-sidebar";

import { AutoHide } from "./auto-hide";
import { NavDock } from "./nav-dock";

export { DockSheet } from "./nav-dock";

/** The dock's row at the window's top or bottom edge, the bar centred in it. */
export function DockRow({ edge, inert }: { edge: "top" | "bottom"; inert: boolean }) {
  return (
    <div
      data-testid="nav-dock-row"
      inert={inert}
      className={cn(
        "flex shrink-0 justify-center bg-background px-2",
        edge === "top" ? "pt-1.5 pb-1 [-webkit-app-region:drag]" : "pt-1 pb-1.5",
      )}
    >
      <div className="flex max-w-full [-webkit-app-region:no-drag]">
        <NavDock edge={edge} />
      </div>
    </div>
  );
}

/** The dock, held out of view at its edge until it is wanted. */
export function AutoHideDock({ edge, inert }: { edge: "top" | "bottom"; inert: boolean }) {
  return (
    <AutoHide edge={edge} inert={inert}>
      <NavDock edge={edge} />
    </AutoHide>
  );
}

/** The sidebar, open or compact, held out of view at the window's left until it is wanted. */
export function AutoHideSidebar({
  compact,
  width,
  inert,
}: {
  compact: boolean;
  width: number;
  inert: boolean;
}) {
  return (
    <AutoHide edge="left" width={width} inert={inert}>
      {compact ? <OverviewRail /> : <OverviewSidebar />}
    </AutoHide>
  );
}

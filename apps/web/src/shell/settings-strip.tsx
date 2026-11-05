import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { cn } from "@/lib/utils";
import { leaveSettings } from "@/settings/leave-settings";

/**
 * The overview's column while Settings is open: a narrow strip whose one control goes back to
 * where you came from, as Esc does. The overview's own mode is left as it was, so leaving
 * Settings brings it back unchanged.
 */
export function SettingsStrip() {
  const navigate = useNavigate();
  return (
    <aside
      aria-label="Leave settings"
      data-testid="settings-strip"
      data-surface="chrome"
      className="flex min-h-0 flex-1 flex-col items-center border-r border-border bg-sidebar text-sidebar-foreground"
    >
      {/* The title bar's row, which macOS's window buttons may sit in; Back is just below it. */}
      <div className="h-(--titlebar-height) shrink-0 self-stretch [-webkit-app-region:drag]" />
      <button
        type="button"
        data-testid="settings-back"
        title="Back (Esc)"
        onClick={() => leaveSettings(navigate)}
        className={cn(
          "mt-2 flex shrink-0 flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-meta text-muted-foreground outline-none [-webkit-app-region:no-drag]",
          "hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        <ArrowLeft aria-hidden className="size-icon-row" />
        Back
      </button>
    </aside>
  );
}

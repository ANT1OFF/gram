import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { leaveSettings } from "@/settings/leave-settings";

/**
 * The title bar's left while Settings is open, in place of the workspace and Chat · Board: Back,
 * as Esc does, then where you are. Settings is a place of its own, not a view of a workspace, so
 * nothing of the workspace's shows beside it; the overview steps aside and comes back as it was.
 */
export function SettingsTitle() {
  const navigate = useNavigate();
  return (
    <div data-testid="settings-title" className="flex min-w-0 items-center gap-2">
      <Hint
        label="Back (Esc)"
        side="bottom"
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="settings-back"
            aria-label="Back"
            className="shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
            onClick={() => leaveSettings(navigate)}
          />
        }
      >
        <ArrowLeft aria-hidden />
      </Hint>
      {/* The page's name, as a thread's title is; the page's own heading stays for the keyboard
          and screen readers (`SettingsNav`). */}
      <span className="truncate text-reading font-medium text-foreground">Settings</span>
    </div>
  );
}

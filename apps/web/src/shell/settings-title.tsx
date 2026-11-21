import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { orchestratorRowTitle } from "@/orchestration/tree-model";
import { leaveSettings, settingsReturn } from "@/settings/leave-settings";
import { placeOf } from "@/shell/came-from";
import { useThreadsStore } from "@/stores/threads";

function useBackLabel(): string {
  const place = placeOf(new URL(settingsReturn(), "http://gram.invalid").pathname);
  const title = useThreadsStore((s) => {
    const thread = place?.kind === "thread" ? s.byId[place.threadId]?.thread : undefined;
    return thread?.role === "orchestrator" ? orchestratorRowTitle(thread.title) : thread?.title;
  });
  return title === undefined || title.trim() === "" ? "Back" : `Back to ${title}`;
}

/**
 * The title bar's left while Settings is open, in place of the workspace and Chat · Board: Back,
 * as Esc does, naming the thread it returns to on hover, then where you are. Settings is a place of
 * its own, not a view of a workspace, so nothing of the workspace's shows beside it; the overview
 * steps aside and comes back as it was.
 */
export function SettingsTitle() {
  const navigate = useNavigate();
  const back = useBackLabel();
  return (
    <div data-testid="settings-title" className="flex min-w-0 items-center gap-2">
      <Hint
        label={`${back} (Esc)`}
        side="bottom"
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="settings-back"
            aria-label={back}
            className="shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
            onClick={() => leaveSettings(navigate)}
          />
        }
      >
        <ArrowLeft aria-hidden />
      </Hint>
      <span className="truncate text-reading font-medium text-foreground">Settings</span>
    </div>
  );
}

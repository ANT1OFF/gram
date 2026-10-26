import { noticeActionsOn, type Settings, type SettingsPatch } from "@gram/contracts";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useWorkspaces } from "@/orchestration/use-orchestration";

import { OPTION_GROUP, SettingRow, Toggle } from "./fields";

type NotificationsPatch = NonNullable<SettingsPatch["notifications"]>;

/**
 * Settings for asks' desktop notifications: whether
 * Allow and Merge sit on them, and which workspaces stay quiet. Self-contained, so it moves with
 * the Notifications group.
 */
export function AwayNotificationRows({
  settings,
  apply,
  resetOf,
  errorOf,
}: {
  settings: Settings;
  apply: (key: "actions" | "mutedWorkspaces", patch: NotificationsPatch) => void;
  resetOf: (key: "actions" | "mutedWorkspaces") => (() => void) | undefined;
  errorOf: (key: "actions" | "mutedWorkspaces") => string | undefined;
}) {
  const workspaces = useWorkspaces();
  const muted = settings.notifications.mutedWorkspaces ?? [];
  const off = !settings.notifications.native;
  const offReason = off ? "Turn on Desktop notifications first." : undefined;
  const toggle = (id: string) =>
    apply("mutedWorkspaces", {
      mutedWorkspaces: muted.includes(id) ? muted.filter((m) => m !== id) : [...muted, id],
    });
  return (
    <>
      <Toggle
        label="Actions in notifications"
        description="Allow and Merge answer an ask from its notification."
        learnMore={
          <p>
            The exact command is always shown. One cut short offers only Open, which shows it whole
            in the ask stack.
          </p>
        }
        keywords={["allow", "merge", "away", "notify"]}
        checked={noticeActionsOn(settings)}
        disabled={off}
        disabledReason={offReason}
        onReset={resetOf("actions")}
        error={errorOf("actions")}
        onChange={(actions) => apply("actions", { actions })}
      />
      {workspaces.length > 0 && (
        <SettingRow
          label="Muted workspaces"
          description="Their asks and failures never notify."
          keywords={["mute", "quiet", "workspace"]}
          disabledReason={offReason}
          onReset={resetOf("mutedWorkspaces")}
          error={errorOf("mutedWorkspaces")}
        >
          <div role="group" aria-label="Muted workspaces" className={OPTION_GROUP}>
            {workspaces.map(({ workspace }) => {
              const on = muted.includes(workspace.id);
              return (
                <Button
                  key={workspace.id}
                  size="sm"
                  aria-pressed={on}
                  disabled={off}
                  variant={on ? "secondary" : "ghost"}
                  onClick={() => toggle(workspace.id)}
                >
                  {on && <Check aria-hidden data-icon="inline-start" />}
                  {workspace.name}
                </Button>
              );
            })}
          </div>
        </SettingRow>
      )}
    </>
  );
}

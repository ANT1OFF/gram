import type { NotificationStatus } from "@gram/contracts";
import { BellRing, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";

import { errorMessage } from "@/api/errors";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { formatClockTime } from "@/lib/time";

import { SettingRow } from "./fields";

/**
 * What the row says about the newest notification. Electron can't read whether the system allows
 * them, so it says what the system did with the last one, never "allowed" or "denied".
 */
export function notificationStatusText(
  status: NotificationStatus,
  clock: (at: number) => string = formatClockTime,
): string {
  if (!status.supported) return "Not supported on this system";
  const { last } = status;
  if (last === null) return "Nothing sent since Gram started";
  const what = last.test ? "Test" : "Last one";
  const at = clock(last.at);
  switch (last.outcome) {
    case "sent":
      return `${what} sent at ${at}, not confirmed yet`;
    case "shown":
      return `${what} shown at ${at}`;
    case "clicked":
      return `${what} clicked at ${at}`;
    case "failed":
      return `${what} refused at ${at}`;
  }
}

/**
 * Notifications, as far as the desktop shell can tell: the newest one's outcome, a test, and the
 * system's settings for Gram. Nothing in a browser.
 */
export function NotificationStatusSetting() {
  const bridge = window.gram?.notificationStatus;
  const platform = window.gram?.platform;
  const [status, setStatus] = useState<NotificationStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    let changed = false;
    const unsubscribe = bridge?.onChange((next) => {
      changed = true;
      setStatus(next);
    });
    void bridge
      ?.get()
      .then((value) => {
        if (live && !changed) setStatus(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [bridge]);
  if (bridge === undefined || status === undefined) return null;
  const refused = status.last?.outcome === "failed" ? status.last.error : undefined;
  return (
    <SettingRow
      label="Delivery status"
      description="Gram can't read whether the system allows its notifications, so this says what happened to the newest one. Focus can still hide one that showed."
      keywords={["notifications", "permission", "test", "allowed", "banner", "alerts"]}
      error={error ?? refused}
    >
      <span className="text-xs text-muted-foreground" data-testid="notification-status">
        {notificationStatusText(status)}
      </span>
      {status.supported && (
        <Hint
          label="Send test notification"
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Send test notification"
              onClick={() => {
                setError(undefined);
                bridge.sendTest().catch((e: unknown) => setError(errorMessage(e)));
              }}
            />
          }
        >
          <BellRing aria-hidden />
        </Hint>
      )}
      {(platform === "darwin" || platform === "win32") && (
        <Hint
          label="Open Notification settings"
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open Notification settings"
              onClick={() => void bridge.openSettings()}
            />
          }
        >
          <Settings2 aria-hidden />
        </Hint>
      )}
    </SettingRow>
  );
}

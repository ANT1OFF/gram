// What happened to Gram's newest notification, for Settings' notification row. Electron reports no
// authorization status, so the row can't say "allowed" or "denied"; it says what the OS did with
// the last notification instead: accepted it (`show`), refused it (`failed`, which on macOS is how
// not being allowed shows), or nothing yet. A click on any of them proves delivery too.

import type { NotificationStatus } from "@gram/contracts";

/** The events of an Electron `Notification` this reads. */
export interface WatchedNotification {
  on(event: "show" | "click" | "action", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
}

export function createNotificationStatus(deps: {
  readonly supported: boolean;
  readonly now: () => number;
  readonly onChange: (status: NotificationStatus) => void;
}) {
  let last: NotificationStatus["last"] = null;
  let newest = 0;
  const status = (): NotificationStatus => ({ supported: deps.supported, last });

  return {
    status,
    /** Follows `note` from now on; call before showing it. */
    watch(note: WatchedNotification, test = false): void {
      const id = ++newest;
      const record = (outcome: "sent" | "shown" | "clicked" | "failed", error?: string) => {
        // An older notification's events would misreport the newest's, but its click still shows
        // notifications reach the user.
        if (id !== newest && outcome !== "clicked") return;
        // Shown again after a click, as macOS may, is still a click.
        if (outcome === "shown" && last?.outcome === "clicked" && id === newest) return;
        last = {
          outcome,
          at: deps.now(),
          test,
          ...(error === undefined || error === "" ? {} : { error }),
        };
        deps.onChange(status());
      };
      record("sent");
      note.on("show", () => record("shown"));
      note.on("click", () => record("clicked"));
      note.on("action", () => record("clicked"));
      note.on("failed", (_event, error) => record("failed", String(error)));
    },
  };
}

export type NotificationStatusTracker = ReturnType<typeof createNotificationStatus>;

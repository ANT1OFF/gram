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
        if (id !== newest && outcome !== "clicked") return;
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

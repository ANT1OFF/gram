import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Bell,
  Check,
  CheckCheck,
  CircleAlert,
  CircleCheck,
  Info,
  MessageCircleQuestion,
  Trash2,
} from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { notificationTime } from "@/lib/time";
import { useReturnFocus } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { focusWhenAble } from "@/orchestration/use-focus-on-open";
import { useLayoutStore } from "@/stores/layout";
import { useNotificationHistory, unreadNotifications } from "@/stores/notifications";
import { useThreadsStore } from "@/stores/threads";

const KINDS = {
  info: { icon: Info, label: "Notice", tone: "text-info" },
  done: { icon: CircleCheck, label: "Done", tone: "text-success" },
  needsInput: { icon: MessageCircleQuestion, label: "Needs you", tone: "text-status-needs" },
  error: { icon: CircleAlert, label: "Error", tone: "text-destructive" },
};

export function NotificationsBell() {
  const unread = useNotificationHistory(unreadNotifications);
  const reveal = useLayoutStore((s) => s.revealPanel);
  const label = unread ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          data-testid="notifications-bell"
          className="relative shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={() => reveal("notifications")}
        />
      }
    >
      <Bell aria-hidden />
      {unread > 0 && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 rounded-full bg-status-needs px-1 text-[9px] leading-3 text-background tabular-nums"
        >
          {unread}
        </span>
      )}
    </Hint>
  );
}

export function NotificationsPanel() {
  useReturnFocus(() => document.querySelector('[data-testid="notifications-bell"]'));
  const header = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    useNotificationHistory.getState().prune();
    if (document.activeElement?.matches('[data-testid="notifications-bell"]'))
      header.current?.focus();
  }, []);
  const storageUnavailable = useNotificationHistory((s) => s.storageUnavailable);
  const entries = useNotificationHistory((s) => s.entries);
  const unread = useNotificationHistory(unreadNotifications);
  const markRead = useNotificationHistory((s) => s.markRead);
  const clear = useNotificationHistory((s) => s.clear);
  const byId = useThreadsStore((s) => s.byId);
  const ready = useThreadsStore((s) => s.ready);
  const navigate = useNavigate();
  return (
    <section
      aria-label="Notification history"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        useLayoutStore.getState().togglePanel();
        const bell = document.querySelector<HTMLButtonElement>(
          '[data-testid="notifications-bell"]',
        );
        if (bell) focusWhenAble(bell);
      }}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p
          ref={header}
          tabIndex={-1}
          className="min-w-0 flex-1 text-xs text-muted-foreground outline-none"
        >
          {unread > 0 ? `${unread} unread` : "All caught up"}
        </p>
        <Hint
          label="Mark all read"
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Mark all read"
              disabled={unread === 0}
              onClick={() => {
                header.current?.focus();
                markRead();
              }}
            />
          }
        >
          <CheckCheck />
        </Hint>
        <Hint
          label="Clear history"
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear history"
              disabled={entries.length === 0}
              onClick={() => {
                header.current?.focus();
                clear();
              }}
            />
          }
        >
          <Trash2 />
        </Hint>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center text-muted-foreground">
            <Bell aria-hidden className="size-5" />
            <p className="text-sm">No notifications yet</p>
            <p className="text-xs">Notices stay here after their toasts close.</p>
          </div>
        ) : (
          <ol aria-label="Stored notifications" className="divide-y divide-border">
            {entries.map((entry) => {
              const kind = KINDS[entry.kind];
              return (
                <li
                  key={entry.id}
                  data-testid="notification-entry"
                  tabIndex={-1}
                  className="px-3 py-3"
                >
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <kind.icon aria-hidden className={cn("size-3.5 shrink-0", kind.tone)} />
                    <span>{kind.label}</span>
                    {!entry.read && (
                      <span className="size-1.5 rounded-full bg-status-needs" aria-label="Unread" />
                    )}
                    <time
                      className="ml-auto tabular-nums"
                      dateTime={new Date(entry.lastSeen).toISOString()}
                    >
                      {notificationTime(entry.lastSeen)}
                    </time>
                    {!entry.read && (
                      <Hint
                        label="Mark read"
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`Mark read: ${entry.title}`}
                            onClick={(event) => {
                              event.currentTarget.closest("li")?.focus();
                              markRead(entry.id);
                            }}
                          />
                        }
                      >
                        <Check />
                      </Hint>
                    )}
                  </div>
                  <p className="mt-2 text-sm leading-snug font-medium wrap-anywhere">
                    {entry.title}
                  </p>
                  {entry.body && (
                    <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground wrap-anywhere">
                      {entry.body}
                    </p>
                  )}
                  {entry.source && (
                    <p className="mt-2 text-xs text-muted-foreground wrap-anywhere">
                      {entry.source}
                    </p>
                  )}
                  {entry.count > 1 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Seen {entry.count} times · first{" "}
                      <time dateTime={new Date(entry.firstSeen).toISOString()}>
                        {notificationTime(entry.firstSeen)}
                      </time>
                    </p>
                  )}
                  {entry.threadIds.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {entry.threadIds.map((id) => {
                        const target = byId[id];
                        return target ? (
                          <button
                            key={id}
                            type="button"
                            className="max-w-full truncate rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => {
                              markRead(entry.id);
                              // Recheck at activation: a thread may have been deleted while this row was focused.
                              if (useThreadsStore.getState().byId[id])
                                void navigate({ to: "/t/$threadId", params: { threadId: id } });
                            }}
                          >
                            {target.thread.title || "Open thread"}
                          </button>
                        ) : (
                          <span key={id} className="text-muted-foreground">
                            {ready ? "Thread no longer available" : "Loading thread…"}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <p className="shrink-0 border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        {storageUnavailable
          ? "Session only · local storage unavailable"
          : "On this device · latest 100 · 30 days"}
      </p>
    </section>
  );
}

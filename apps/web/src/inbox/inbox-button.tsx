import { Inbox } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useNeedsYou } from "@/orchestration/use-needs-you";

import { useInboxStore } from "./inbox-store";

// The title bar's Inbox button, where the notifications bell was: everything that needs you. While
// the sidebar is shown its pill is the window's one count, so the button carries none; with the
// sidebar hidden the button wears the count, in amber while anything waits. Either way its name says
// the count. Notification history is a link in the Inbox's header and a tab of the side panel.

export function InboxButton({
  badge = true,
}: {
  /** Whether it shows the count itself: only when no sidebar pill shows it. */
  badge?: boolean;
}) {
  const { count, open, hint } = useNeedsYou();
  const shown = useInboxStore((s) => s.open);
  const words = count > 0 ? `Inbox, ${count} ${count === 1 ? "needs" : "need"} you` : "Inbox";
  const label = hint === undefined ? words : `${words} (${hint})`;
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={shown}
          data-testid="inbox-button"
          data-count={count}
          data-badge={(badge && count > 0) || undefined}
          className="relative shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={open}
        />
      }
    >
      <Inbox aria-hidden />
      {badge && count > 0 && (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 min-w-3.5 rounded-full border border-status-needs-mark bg-background px-0.5 text-center text-caption leading-3 font-semibold text-status-needs tabular-nums"
        >
          {count}
        </span>
      )}
    </Hint>
  );
}

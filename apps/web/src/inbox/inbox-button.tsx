import { Inbox } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { needsYouPillWords, needsYouScope, needsYouSpoken } from "@/orchestration/needs-you-entry";
import { asksAmong } from "@/orchestration/needs-you-items";
import { useNeedsYouPill } from "@/orchestration/use-needs-you";

import { useInboxStore } from "./inbox-store";

// The title bar's way into the Inbox, only while no pill is on screen (the sidebar hidden, or
// Settings' strip in its place): the open sidebar's pill and the compact rail's are the one way in
// beside them, and the one place what needs you is said in words. Here it is one of the bar's icon
// buttons, in one fixed slot whatever is waiting, so nothing beside it moves as asks come and go:
// the Inbox glyph, a dot on its corner while anything waits (amber only while something asks, as
// the pill's dot; neutral for errors alone), never a number, and the pill's words on hover and in
// its name. Notification history is a link in the Inbox's header and a tab of the side panel.

export function InboxButton() {
  const { count, parts, scope, hint, open, openAsks } = useNeedsYouPill();
  const shown = useInboxStore((s) => s.open);
  const asks = asksAmong(count, parts);
  const label =
    count > 0
      ? `${withHint(needsYouPillWords(count, parts, 3), hint)}\n${needsYouScope(count, scope)}`
      : withHint("Inbox", hint);
  const name = count > 0 ? withHint(needsYouSpoken(count, parts), hint) : withHint("Inbox", hint);
  return (
    <Hint
      label={label}
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={name}
          aria-pressed={shown}
          data-testid="inbox-button"
          data-count={count}
          data-asks={asks || undefined}
          className="relative shrink-0 text-muted-foreground [-webkit-app-region:no-drag] aria-pressed:bg-accent aria-pressed:text-foreground"
          onClick={count > 0 ? openAsks : open}
        />
      }
    >
      <Inbox aria-hidden />
      {count > 0 && (
        <span
          aria-hidden
          data-testid="inbox-button-dot"
          className={cn(
            "absolute top-1 right-1 size-2 rounded-full ring-2 ring-thread",
            asks ? "bg-status-needs-mark" : "bg-foreground",
          )}
        />
      )}
    </Hint>
  );
}

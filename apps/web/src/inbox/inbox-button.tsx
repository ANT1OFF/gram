import { Inbox } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { NeedsYouEntry } from "@/orchestration/needs-you-entry";
import { useNeedsYou } from "@/orchestration/use-needs-you";

import { useInboxStore } from "./inbox-store";

// The title bar's way into the Inbox, only while no pill is on screen (the sidebar hidden, or
// Settings' strip in its place): the open sidebar's pill and the compact rail's are the one way in
// beside them. With anything waiting it is that pill's own entry, "2 need you" (`NeedsYouEntry`),
// never a badge on an icon; with nothing, a quiet Inbox icon. Notification history is a link in the
// Inbox's header and a tab of the side panel.

export function InboxButton() {
  const { count, open, hint } = useNeedsYou();
  const shown = useInboxStore((s) => s.open);
  if (count > 0) {
    return (
      <NeedsYouEntry
        variant="chip"
        data-testid="inbox-button"
        aria-pressed={shown}
        className="[-webkit-app-region:no-drag]"
      />
    );
  }
  const label = hint === undefined ? "Inbox" : `Inbox (${hint})`;
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
          data-count={0}
          className="shrink-0 text-muted-foreground [-webkit-app-region:no-drag]"
          onClick={open}
        />
      }
    >
      <Inbox aria-hidden />
    </Hint>
  );
}

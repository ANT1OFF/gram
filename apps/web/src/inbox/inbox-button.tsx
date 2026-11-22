import { Inbox } from "lucide-react";

import { Hint } from "@/components/hint";
import { useHostAttention } from "@/embed/attention";
import { Button } from "@/components/ui/button";
import { withHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { needsYouPillWords, needsYouScope, needsYouSpoken } from "@/orchestration/needs-you-entry";
import { asksAmong } from "@/orchestration/needs-you-items";
import { useNeedsYouPill } from "@/orchestration/use-needs-you";

import { useInboxStore } from "./inbox-store";

export function InboxButton() {
  const own = useNeedsYouPill();
  const { parts, scope, hint, open, openAsks } = own;
  const host = useHostAttention();
  const count = host?.count ?? own.count;
  const shown = useInboxStore((s) => s.open);
  const asks = host === undefined ? asksAmong(count, parts) : count > 0;
  const label =
    host !== undefined
      ? count > 0
        ? host.words
        : "Inbox"
      : count > 0
        ? `${withHint(needsYouPillWords(count, parts, 3), hint)}\n${needsYouScope(count, scope)}`
        : withHint("Inbox", hint);
  const name =
    host !== undefined
      ? label
      : count > 0
        ? withHint(needsYouSpoken(count, parts), hint)
        : withHint("Inbox", hint);
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
          onClick={host !== undefined ? host.open : count > 0 ? openAsks : open}
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

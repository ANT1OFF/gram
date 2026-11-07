import type { ThreadId } from "@gram/contracts";
import { AlarmClockOff, BellRing, Clock, Mail, MailOpen } from "lucide-react";
import { useState } from "react";

import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";

import { snoozePresets, snoozeTime } from "./snooze-model";
import { useThreadActions } from "./use-thread-actions";

const WHEN = "ml-auto pl-4 text-meta text-muted-foreground tabular-nums";

/** The presets from the moment the submenu opened, so their times hold still while it is open. */
const usePresets = () => {
  const [now] = useState(() => Date.now());
  return { now, presets: snoozePresets(now) };
};

/** The row menu's snooze items: the presets, each with when it ends, then a time of the user's. */
function ContextSnoozeItems({ threadId }: { threadId: ThreadId }) {
  const actions = useThreadActions(threadId);
  const { now, presets } = usePresets();
  const snooze = actions.snooze;
  if (snooze === undefined) return null;
  return (
    <>
      {presets.map((preset) => (
        <ContextMenuItem
          key={preset.id}
          data-testid={`menu-snooze-${preset.id}`}
          onClick={() => snooze(preset.at)}
        >
          <Clock aria-hidden className="size-icon-row" />
          {preset.label}
          <span className={WHEN}>{snoozeTime(preset.at, now)}</span>
        </ContextMenuItem>
      ))}
      <ContextMenuItem data-testid="menu-snooze-custom" onClick={actions.snoozeCustom}>
        <Clock aria-hidden className="size-icon-row" />
        Pick a time…
      </ContextMenuItem>
    </>
  );
}

/**
 * A solo row's one way to come back to a thread later: mark it unread, or snooze it until a time,
 * out of the list until then. One submenu keeps the row menu at its cap.
 */
export function LaterContextMenuItems({ threadId }: { threadId: ThreadId }) {
  const actions = useThreadActions(threadId);
  const { thread } = actions;
  if (!thread) return null;
  const snoozed = thread.snoozedUntil !== undefined;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger data-testid="menu-later">
        <BellRing aria-hidden className="size-icon-row" />
        Come back later
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem data-testid="menu-unread" onClick={actions.toggleUnread}>
          {thread.unread ? (
            <MailOpen aria-hidden className="size-icon-row" />
          ) : (
            <Mail aria-hidden className="size-icon-row" />
          )}
          {thread.unread ? "Mark read" : "Mark unread"}
        </ContextMenuItem>
        {actions.snooze !== undefined && (
          <>
            <ContextMenuSeparator />
            {snoozed && (
              <ContextMenuItem
                data-testid="menu-unsnooze"
                onClick={() => actions.snooze?.(undefined)}
              >
                <AlarmClockOff aria-hidden className="size-icon-row" />
                Unsnooze
              </ContextMenuItem>
            )}
            <ContextSnoozeItems threadId={threadId} />
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

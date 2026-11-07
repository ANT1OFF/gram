import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@gram/contracts";
import { AlarmClockOff, BellRing, ChevronRightIcon, Clock, Mail, MailOpen } from "lucide-react";
import { useState } from "react";

import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";

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

/** The header menu's snooze items, as `ContextSnoozeItems` has them. */
function MenuSnoozeItems({
  threadId,
  itemClassName,
}: {
  threadId: ThreadId;
  itemClassName: string;
}) {
  const actions = useThreadActions(threadId);
  const { now, presets } = usePresets();
  const snooze = actions.snooze;
  if (snooze === undefined) return null;
  return (
    <>
      {presets.map((preset) => (
        <Menu.Item
          key={preset.id}
          data-testid={`menu-snooze-${preset.id}`}
          className={itemClassName}
          onClick={() => snooze(preset.at)}
        >
          <Clock aria-hidden className="size-icon-row" />
          {preset.label}
          <span className={WHEN}>{snoozeTime(preset.at, now)}</span>
        </Menu.Item>
      ))}
      <Menu.Item
        data-testid="menu-snooze-custom"
        className={itemClassName}
        onClick={actions.snoozeCustom}
      >
        <Clock aria-hidden className="size-icon-row" />
        Pick a time…
      </Menu.Item>
    </>
  );
}

/**
 * The pane header's Snooze: a submenu of the presets and a time of the user's, or Unsnooze while it
 * is snoozed. Absent for a workspace's orchestrator.
 */
export function SnoozeMenuItems({
  threadId,
  itemClassName,
}: {
  threadId: ThreadId;
  itemClassName: string;
}) {
  const actions = useThreadActions(threadId);
  const { thread } = actions;
  if (!thread || actions.snooze === undefined) return null;
  if (thread.snoozedUntil !== undefined) {
    return (
      <Menu.Item
        data-testid="menu-unsnooze"
        className={itemClassName}
        onClick={() => actions.snooze?.(undefined)}
      >
        <AlarmClockOff aria-hidden className="size-icon-row" />
        Unsnooze
      </Menu.Item>
    );
  }
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger
        data-testid="menu-snooze"
        className={cn(itemClassName, "data-[popup-open]:row-cursor")}
      >
        <Clock aria-hidden className="size-icon-row" />
        Snooze
        <ChevronRightIcon aria-hidden className="ml-auto text-muted-foreground" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          side="right"
          align="start"
          alignOffset={-4}
          className="isolate z-50 outline-none"
        >
          <Menu.Popup data-testid="menu-snooze-popup" aria-label="Snooze" className={MENU_POPUP}>
            <MenuSnoozeItems threadId={threadId} itemClassName={itemClassName} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

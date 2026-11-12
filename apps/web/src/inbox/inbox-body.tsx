import { Dialog } from "@base-ui/react/dialog";
import {
  AlarmClock,
  Bell,
  CircleCheck,
  Inbox as InboxIcon,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { EmptyState, type EmptyAction } from "@/components/empty-state";
import { Hint } from "@/components/hint";
import { useHistoryStore } from "@/history/history-view";
import { Button } from "@/components/ui/button";
import { keyLabel } from "@/keyboard/registry";
import { formatRelative, formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { types } from "@/orchestration/ask-keys";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import {
  briefTitle,
  sectionsIn,
  type NeedsYouItem,
  type NeedsYouSection,
} from "@/orchestration/needs-you-items";
import {
  kindOf,
  NeedsYouUndo,
  SectionHead,
  useNeedsYouActions,
} from "@/orchestration/needs-you-row";
import { NeedsYouStrip } from "@/orchestration/needs-you-strip";
import { useNeedsYouJump, useNeedsYouList } from "@/orchestration/use-needs-you";
import { SideResizeHandle } from "@/shell/side-resize";
import { useLayoutStore } from "@/stores/layout";
import { PhoneSheetHeader } from "@/thread/dialog-shell";
import { useNotificationHistory, unreadNotifications } from "@/stores/notifications";

import { InboxDetail } from "./inbox-detail";
import {
  INBOX_LIST_COMPACT,
  INBOX_LIST_COMPACT_BELOW,
  INBOX_LIST_WIDTH,
  inboxListWidth,
  useInboxStore,
} from "./inbox-store";

// The Inbox: everything that needs the user, across every workspace, in one place. A list by kind
// (errors, approvals, questions, reviews, steps, drafts) with the category strip above it, and the
// picked item in a pane beside it with everything it takes to answer it. It is a dialog over the
// work (`InboxView`), the same in Quiet and out of it, at every window size. Every count in the
// window is this list's (`needsYouCounts`): the title bar's button, the sidebar's pill, each
// workspace's badge, the window title and the dock badge. Keys: j/k or ↓/↑ move, ⏎ opens the
// item's thread, 1–9 pick, ⌘⏎ sends, ⌘Z takes the last answer back, esc closes.

/** The item `selected` names, or the one now in its place (`lastIndex`) once it is gone. */
const selectedIn = (
  items: readonly NeedsYouItem[],
  selected: string | undefined,
  lastIndex: number,
): NeedsYouItem | undefined => {
  const found = items.find((item) => item.key === selected);
  if (found !== undefined) return found;
  if (items.length === 0) return undefined;
  return items[Math.min(lastIndex, items.length - 1)];
};

/**
 * How many requests a list holds before the category strip heads it: fewer are all in sight, each
 * under its own section heading, at the Inbox's smallest size too.
 */
export const STRIP_FROM = 7;

const CLOSE = {
  size: "icon-xs",
  variant: "ghost",
  "aria-label": "Close Inbox",
  title: "Close (esc)",
  "data-testid": "inbox-close",
} as const;

/** The Inbox's list and detail, in its dialog, which titles and closes it; loaded apart from the shell. */
export function InboxBody() {
  // On a phone the dialog is a full-screen sheet: one column of cards, answered by touch.
  const phone = usePhone();
  const { sections, later } = useNeedsYouList();
  const category = useInboxStore((s) => s.category);
  const setCategory = useInboxStore((s) => s.setCategory);
  const showLater = useInboxStore((s) => s.later);
  const setLater = useInboxStore((s) => s.setLater);
  const selected = useInboxStore((s) => s.selected);
  const select = useInboxStore((s) => s.select);
  const jump = useNeedsYouJump();
  const actions = useNeedsYouActions();
  const now = useNow(true, undefined, 60_000);
  const unread = useNotificationHistory(unreadNotifications);
  const listRef = useRef<HTMLDivElement>(null);
  // The request list beside the detail: full (two lines a request) or compact (one), by its width,
  // which its divider drags and Compact list toggles.
  const listWidth = inboxListWidth(useInboxStore((s) => s.listWidth));
  const compact = listWidth < INBOX_LIST_COMPACT_BELOW;
  const setListWidth = useInboxStore((s) => s.setListWidth);
  const total = sections.reduce((n, section) => n + section.items.length, 0);
  const shown = sectionsIn(sections, category);
  const items = shown.flatMap((section) => section.items);
  // Where the selection was, so an answered item gives way to the one after it.
  const [lastIndex, setLastIndex] = useState(0);
  const current = selectedIn(items, selected, lastIndex);
  const index = current === undefined ? -1 : items.indexOf(current);
  if (index >= 0 && index !== lastIndex) setLastIndex(index);
  useEffect(() => {
    if (current !== undefined && current.key !== selected) select(current.key);
  }, [current, selected, select]);
  useEffect(() => {
    if (current === undefined) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-key="${CSS.escape(current.key)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const move = (by: 1 | -1) => {
    if (items.length === 0) return;
    const at = index < 0 ? (by === 1 ? 0 : items.length - 1) : index + by;
    const next = items[Math.max(0, Math.min(items.length - 1, at))];
    if (next !== undefined) select(next.key);
  };
  const undo = () => {
    const answer = useAskStackStore.getState().undo();
    if (answer === undefined) return false;
    // The ask comes back: show it again, where it was answered.
    select(items.some((item) => item.key === answer.key) ? answer.key : `ask:${answer.key}`);
    return true;
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    const typing = target !== null && types(target);
    const mod = event.metaKey || event.ctrlKey;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "z") {
      if (typing) return;
      if (undo()) take();
      return;
    }
    if (typing || mod || event.altKey || event.shiftKey) return;
    // A button or a link keeps its own Enter and Space.
    const activates = target?.closest("button, a, [role='radio'], [role='checkbox']") != null;
    if (event.key === "j" || event.key === "ArrowDown") {
      take();
      move(1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      take();
      move(-1);
    } else if (event.key === "Enter" && !activates && current !== undefined) {
      take();
      if (current.threadId !== undefined) jump(current);
    }
  };

  const laterButton = (
    <Hint
      label={showLater ? "Back to what needs you" : "Later"}
      side="bottom"
      render={
        <Button
          size="xs"
          variant={showLater ? "secondary" : "ghost"}
          aria-pressed={showLater}
          aria-label={`Later, ${later.length}`}
          data-testid="inbox-show-later"
          onClick={() => setLater(!showLater)}
        />
      }
    >
      Later
      {later.length > 0 && <span className="tabular-nums">{later.length}</span>}
    </Hint>
  );
  // The strip, when it shows, sits right under the header: one line between the two, under it.
  // It is there so a long list never hides a category below the fold; a short one has every
  // section's heading in sight already, and the strip only said them twice. A pick keeps it, as
  // the way back to All.
  const strip =
    !showLater && sections.length > 1 && (total >= STRIP_FROM || shown.length < sections.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      {phone ? (
        <PhoneSheetHeader title="Needs you" closeLabel="Close Inbox" testId="inbox-close">
          {laterButton}
        </PhoneSheetHeader>
      ) : (
        <header
          className={cn(
            "flex shrink-0 items-center gap-2 px-3",
            strip ? "pt-2" : "border-b border-shell-divider py-2",
          )}
        >
          <InboxIcon aria-hidden className="size-icon-row text-muted-foreground" />
          <Dialog.Title className="text-title">Inbox</Dialog.Title>
          <p
            data-testid="inbox-count"
            className="min-w-0 flex-1 truncate text-meta text-muted-foreground"
          >
            {showLater
              ? `${later.length} for later`
              : total === 0
                ? "Nothing needs you"
                : `${total} need${total === 1 ? "s" : ""} you`}
          </p>
          {laterButton}
          {!showLater && total > 0 && (
            <Hint
              label={compact ? "Full list" : "Compact list"}
              side="bottom"
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-pressed={compact}
                  aria-label="Compact list"
                  data-testid="inbox-compact"
                  onClick={() => setListWidth(compact ? undefined : INBOX_LIST_COMPACT)}
                />
              }
            >
              {compact ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
            </Hint>
          )}
          {/* A way out to the history, not a peer of the Inbox's own controls: its glyph, named on
            hover, with the unread count beside it while there is one. */}
          <Hint
            label="Notification history, in the side panel"
            side="bottom"
            render={
              <Button
                size={unread > 0 ? "xs" : "icon-xs"}
                variant="ghost"
                data-testid="inbox-notifications"
                aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
                onClick={() => {
                  useInboxStore.getState().close();
                  useLayoutStore.getState().revealPanel("notifications");
                }}
              />
            }
          >
            <Bell aria-hidden data-icon={unread > 0 ? "inline-start" : undefined} />
            {unread > 0 && <span className="tabular-nums">{unread}</span>}
          </Hint>
          <Dialog.Close render={<Button {...CLOSE} />}>
            <X aria-hidden />
          </Dialog.Close>
        </header>
      )}
      {strip && (
        <NeedsYouStrip
          sections={sections}
          category={category}
          onPick={setCategory}
          className="shrink-0 border-b border-shell-divider px-2 pt-0.5 pb-1"
        />
      )}
      {showLater ? (
        <LaterList later={later} now={now} onWake={actions.wake} />
      ) : total === 0 ? (
        <Empty laterCount={later.length} />
      ) : phone ? (
        <div
          ref={listRef}
          role="list"
          aria-label="Needs you"
          tabIndex={-1}
          data-testid="inbox-list"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 outline-none"
        >
          {shown.map((section) => (
            <section
              key={section.key}
              aria-label={section.label}
              data-testid="inbox-section"
              data-section={section.key}
              className="flex flex-col gap-2"
            >
              <SectionHead label={section.label} count={section.items.length} />
              {section.items.map((item) => (
                <div key={item.key} role="listitem">
                  <InboxDetail item={item} now={now} card onOpenThread={jump} />
                </div>
              ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {/* The detail keeps room for an answer's choices however wide the list is dragged. */}
          <div
            className="flex min-h-0 max-w-[calc(100%-18rem)] shrink-0 flex-col border-r border-shell-divider"
            style={{ width: listWidth }}
          >
            <div
              ref={listRef}
              role="listbox"
              aria-label="Needs you"
              tabIndex={0}
              aria-activedescendant={current === undefined ? undefined : `inbox-row-${index}`}
              data-testid="inbox-list"
              data-compact={compact ? "" : undefined}
              className="min-h-0 flex-1 overflow-y-auto p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              {shown.map((section) => (
                <section
                  key={section.key}
                  aria-label={section.label}
                  data-testid="inbox-section"
                  data-section={section.key}
                >
                  <SectionHead label={section.label} count={section.items.length} />
                  {section.items.map((item) => (
                    <InboxRow
                      key={item.key}
                      item={item}
                      section={section}
                      index={items.indexOf(item)}
                      now={now}
                      selected={item.key === current?.key}
                      compact={compact}
                      onSelect={() => select(item.key)}
                    />
                  ))}
                </section>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {current !== undefined && <InboxDetail item={current} now={now} onOpenThread={jump} />}
          </div>
          {/* The list's divider, over its edge; after the detail, so Tab goes list, detail, it. */}
          <div
            className="pointer-events-none absolute inset-y-0 left-0 max-w-[calc(100%-18rem)] *:pointer-events-auto"
            style={{ width: listWidth }}
          >
            <SideResizeHandle
              side="left"
              label="Resize request list"
              testId="inbox-list-resize"
              width={listWidth}
              bounds={INBOX_LIST_WIDTH}
              onResize={(width) => setListWidth(width)}
              onActive={() => {}}
              onDoubleClick={() => setListWidth(undefined)}
              hint="Drag to resize the list, double-click to reset"
            />
          </div>
        </div>
      )}
      <NeedsYouUndo className="shrink-0 border-t border-shell-divider py-1" />
      {!phone && (
        <div
          data-testid="inbox-keys"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-shell-divider px-3 py-1.5 text-caption text-muted-foreground"
        >
          {/* With nothing listed there is nothing to move through, pick or send: only close. */}
          {total > 0 && (
            <>
              <span>
                <kbd className="font-sans">j k</kbd> move
              </span>
              <span>
                <kbd className="font-sans">{keyLabel("⏎")}</kbd> open thread
              </span>
              <span>
                <kbd className="font-sans">1–9</kbd> pick
              </span>
              <span>
                <kbd className="font-sans">{keyLabel("⌘⏎")}</kbd> send
              </span>
              <span>
                <kbd className="font-sans">{keyLabel("⌘Z")}</kbd> undo
              </span>
            </>
          )}
          <span>
            <kbd className="font-sans">esc</kbd> close
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * What a row says of its kind, in words, where its section's heading doesn't already say it: not
 * "Approval" under Approvals, nor "Plan to review" when its title says it, but "Worker question"
 * under Questions, which is more than the heading says. An error's heading says it.
 */
const rowKind = (
  item: NeedsYouItem,
  section: NeedsYouSection,
  title: string,
): string | undefined => {
  if (item.kind === "failure") return undefined;
  const label = kindOf(item).label;
  const heading = section.label.toLowerCase();
  const said = heading === label.toLowerCase() || heading === `${label.toLowerCase()}s`;
  return said || title.startsWith(label) ? undefined : label;
};

/**
 * One row of the list, two lines: what it is about, wrapping to a second line before it is cut,
 * then where it is from (its workspace, its kind where the heading doesn't say it, its thread) with
 * its age at the line's end. Its hover says the whole of it. The whole question, its choices and
 * its command's arguments are the detail pane's. A click shows it. Compact, a row is its title
 * alone, one line.
 */
function InboxRow({
  item,
  section,
  index,
  now,
  selected,
  compact,
  onSelect,
}: {
  item: NeedsYouItem;
  section: NeedsYouSection;
  index: number;
  now: number;
  selected: boolean;
  /** One line: its kind and title; where it is from is its tooltip and the detail's. */
  compact: boolean;
  onSelect: () => void;
}) {
  const kind = kindOf(item);
  const title = briefTitle(item);
  const where = [
    item.workspace,
    rowKind(item, section, title),
    item.where === "" ? undefined : item.where,
    item.owned || item.kind !== "failure" ? undefined : "no live worker",
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
  const age = item.at === undefined ? undefined : formatRelative(item.at, now);
  // The hover says the whole of it: the full request, not the list's short form, and where from.
  const whole = [
    [item.title, item.command].filter(Boolean).join(" "),
    [where, age].filter(Boolean).join(" · "),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      id={`inbox-row-${index}`}
      role="option"
      aria-selected={selected}
      data-testid="inbox-item"
      data-kind={item.kind}
      data-key={item.key}
      data-thread-id={item.threadId}
      data-workspace={item.workspaceId}
      data-selected={selected || undefined}
      title={whole}
      onClick={onSelect}
      className={cn(
        "grid cursor-default grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-2 rounded-(--radius-md) px-2",
        compact ? "min-h-7 py-1" : "py-1.5",
        selected ? "row-cursor" : "hover:bg-accent",
      )}
    >
      <kind.icon
        aria-label={kind.label}
        role="img"
        className={cn(
          "mt-0.5 size-icon-row",
          item.kind === "failure"
            ? "text-destructive"
            : item.kind === "wait"
              ? "text-muted-foreground"
              : "text-status-needs-mark",
        )}
      />
      <span className="flex min-w-0 flex-col">
        <span
          data-testid="inbox-item-title"
          className={cn(
            "text-body break-words",
            compact ? "truncate" : "line-clamp-2",
            selected && "font-medium",
          )}
        >
          {title}
          {item.command !== undefined && (
            <>
              {" "}
              <code className="font-mono text-meta">{item.command}</code>
            </>
          )}
        </span>
        <span
          className={cn(
            compact
              ? "sr-only"
              : "flex min-w-0 items-baseline gap-2 text-meta text-muted-foreground",
          )}
        >
          <span
            data-testid="inbox-item-where"
            className={cn("min-w-0 flex-1 truncate", !item.owned && "italic")}
          >
            {where}
          </span>
          {age !== undefined && (
            <span data-testid="inbox-item-age" className="shrink-0 tabular-nums">
              {age}
            </span>
          )}
        </span>
      </span>
    </div>
  );
}

function LaterList({
  later,
  now,
  onWake,
}: {
  later: ReturnType<typeof useNeedsYouList>["later"];
  now: number;
  onWake: (item: NeedsYouItem) => void;
}) {
  if (later.length === 0) {
    return (
      <EmptyState
        testId="inbox-empty"
        className="flex-1 justify-center"
        icon={AlarmClock}
        title="Nothing for later"
        line="Later puts an item away for an hour, then brings it back here."
        action={{
          label: "Back to what needs you",
          onClick: () => useInboxStore.getState().setLater(false),
        }}
      />
    );
  }
  return (
    <ul data-testid="inbox-later-list" className="min-h-0 flex-1 overflow-y-auto p-1">
      {later.map(({ item, wakes }) => {
        const kind = kindOf(item);
        return (
          <li
            key={item.key}
            data-testid="inbox-later-item"
            className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-(--radius-md) px-2 py-1.5 hover:bg-muted/60"
          >
            <kind.icon
              aria-label={kind.label}
              className="mt-0.5 size-icon-row text-muted-foreground"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="line-clamp-2 text-body break-words">{item.title}</span>
              <span className="truncate text-meta text-muted-foreground">
                {[item.workspace, item.where].filter(Boolean).join(" · ")} · back at{" "}
                {formatWakeTime(wakes, now)}
              </span>
            </span>
            <Button size="xs" variant="ghost" data-testid="inbox-wake" onClick={() => onWake(item)}>
              Back now
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function Empty({ laterCount }: { laterCount: number }) {
  // What is put away comes first; with nothing put away, what finished is the next place to look.
  const action: EmptyAction =
    laterCount > 0
      ? {
          label: `${laterCount} put away for later`,
          onClick: () => useInboxStore.getState().setLater(true),
        }
      : {
          label: "Open History",
          onClick: () => {
            useInboxStore.getState().close();
            useHistoryStore.getState().show();
          },
        };
  return (
    <EmptyState
      testId="inbox-empty"
      className="flex-1 justify-center"
      icon={CircleCheck}
      iconClassName="text-success"
      title="Nothing needs you"
      line="Approvals, questions and failures from every workspace land here."
      action={action}
    />
  );
}

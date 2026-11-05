import { Dialog } from "@base-ui/react/dialog";
import { AlarmClock, Bell, CircleCheck, Inbox as InboxIcon, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { keyLabel } from "@/keyboard/registry";
import { formatRelative, formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { returnFocusTo, useOpener } from "@/lib/use-return-focus";
import { cn } from "@/lib/utils";
import { types } from "@/orchestration/ask-keys";
import { useAskStackStore } from "@/orchestration/ask-stack-store";
import { sectionsIn, type NeedsYouItem } from "@/orchestration/needs-you-items";
import {
  kindOf,
  NeedsYouUndo,
  SectionHead,
  useNeedsYouActions,
} from "@/orchestration/needs-you-row";
import { NeedsYouStrip } from "@/orchestration/needs-you-strip";
import { useNeedsYouJump, useNeedsYouList } from "@/orchestration/use-needs-you";
import { useLayoutStore } from "@/stores/layout";
import { useNotificationHistory, unreadNotifications } from "@/stores/notifications";

import { InboxDetail } from "./inbox-detail";
import { useInboxStore } from "./inbox-store";

// The Inbox: everything that needs the user, across every workspace, in one place. A list by kind
// (errors, approvals, questions, reviews, steps, drafts) with the category strip above it, and the
// picked item in a pane beside it with everything it takes to answer it. Every count in the window
// is this list's (`needsYouCounts`): the title bar's button, the sidebar's pill, each workspace's
// badge, the window title and the dock badge. Keys: j/k or ↓/↑ move, ⏎ opens the item's thread,
// 1–9 pick, ⌘⏎ sends, ⌘Z takes the last answer back, esc closes.

export const INBOX_TEST_ID = "inbox";

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

export function InboxView() {
  const open = useInboxStore((s) => s.open);
  const close = useInboxStore((s) => s.close);
  const opener = useOpener(open);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={INBOX_TEST_ID}
          data-surface="overlay"
          aria-label="Inbox"
          // The list first, where j/k move; the Later list or the empty state has none.
          initialFocus={() =>
            document.querySelector<HTMLElement>('[data-testid="inbox-list"]') ?? true
          }
          // A thread just opened takes focus in its pane; a dismissal hands it back.
          finalFocus={() =>
            useInboxStore.getState().leftForThread ? false : returnFocusTo(opener)()
          }
          className="fixed top-[6%] left-1/2 z-50 flex h-[min(44rem,86vh)] w-[min(68rem,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <InboxBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InboxBody() {
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

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <InboxIcon aria-hidden className="size-4 text-muted-foreground" />
        <Dialog.Title className="text-sm font-semibold">Inbox</Dialog.Title>
        <p
          data-testid="inbox-count"
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
        >
          {showLater
            ? `${later.length} for later`
            : total === 0
              ? "Nothing needs you"
              : `${total} need${total === 1 ? "s" : ""} you`}
        </p>
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
          <AlarmClock aria-hidden data-icon="inline-start" />
          Later
          {later.length > 0 && <span className="tabular-nums">{later.length}</span>}
        </Hint>
        <Button
          size="xs"
          variant="ghost"
          data-testid="inbox-notifications"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          title="Notification history, in the side panel"
          onClick={() => {
            useInboxStore.getState().close();
            useLayoutStore.getState().revealPanel("notifications");
          }}
        >
          <Bell aria-hidden data-icon="inline-start" />
          Notifications
          {unread > 0 && <span className="tabular-nums">{unread}</span>}
        </Button>
        <Dialog.Close
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Close Inbox"
              title="Close"
              data-testid="inbox-close"
            />
          }
        >
          <X aria-hidden />
        </Dialog.Close>
      </header>
      {!showLater && sections.length > 1 && (
        <NeedsYouStrip
          sections={sections}
          category={category}
          onPick={setCategory}
          className="shrink-0 border-b border-border px-2 py-1"
        />
      )}
      {showLater ? (
        <LaterList later={later} now={now} onWake={actions.wake} />
      ) : total === 0 ? (
        <Empty laterCount={later.length} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            ref={listRef}
            role="listbox"
            aria-label="Needs you"
            tabIndex={0}
            aria-activedescendant={current === undefined ? undefined : `inbox-row-${index}`}
            data-testid="inbox-list"
            className="w-[min(24rem,40%)] shrink-0 overflow-y-auto border-r border-border p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
                    index={items.indexOf(item)}
                    now={now}
                    selected={item.key === current?.key}
                    onSelect={() => select(item.key)}
                  />
                ))}
              </section>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            {current !== undefined && <InboxDetail item={current} now={now} onOpenThread={jump} />}
          </div>
        </div>
      )}
      <NeedsYouUndo className="shrink-0 border-t border-border py-1" />
      <div
        data-testid="inbox-keys"
        className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground"
      >
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
        <span>
          <kbd className="font-sans">esc</kbd> close
        </span>
      </div>
    </div>
  );
}

/** One row of the list: its kind, words, where it is from and how long ago; a click shows it. */
function InboxRow({
  item,
  index,
  now,
  selected,
  onSelect,
}: {
  item: NeedsYouItem;
  index: number;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const kind = kindOf(item);
  const where = [
    item.workspace,
    item.where === "" ? undefined : item.where,
    item.owned || item.kind !== "failure" ? undefined : "no live worker",
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
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
      onClick={onSelect}
      className={cn(
        "grid min-h-9 cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-(--radius-md) px-2 py-1.5",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <kind.icon
        aria-label={kind.label}
        role="img"
        className={cn(
          "mt-0.5 size-4",
          item.kind === "failure"
            ? "text-destructive"
            : item.kind === "wait"
              ? "text-muted-foreground"
              : "text-status-needs-mark",
        )}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span data-testid="inbox-item-title" className="line-clamp-2 text-[13px] break-words">
          {item.title}
          {item.command !== undefined && (
            <>
              {" "}
              <code className="font-mono text-xs">{item.command}</code>
            </>
          )}
        </span>
        <span
          data-testid="inbox-item-where"
          className={cn("truncate text-xs text-muted-foreground", !item.owned && "italic")}
        >
          {where}
        </span>
      </span>
      {item.at !== undefined && (
        <span className="text-xs leading-5 text-muted-foreground tabular-nums">
          {formatRelative(item.at, now)}
        </span>
      )}
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
      <div
        data-testid="inbox-empty"
        className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground"
      >
        <AlarmClock aria-hidden className="size-5" />
        <p className="font-medium text-foreground">Nothing for later</p>
        <p className="text-xs">Later puts an item away for an hour.</p>
      </div>
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
            <kind.icon aria-label={kind.label} className="mt-0.5 size-4 text-muted-foreground" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="line-clamp-2 text-[13px] break-words">{item.title}</span>
              <span className="truncate text-xs text-muted-foreground">
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
  return (
    <div
      data-testid="inbox-empty"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-10 text-center text-sm text-muted-foreground"
    >
      <CircleCheck aria-hidden className="size-5 text-success" />
      <p className="font-medium text-foreground">Nothing needs you</p>
      <p className="text-xs">Every workspace is clear.</p>
      {laterCount > 0 && (
        <Button size="xs" variant="ghost" onClick={() => useInboxStore.getState().setLater(true)}>
          <AlarmClock aria-hidden data-icon="inline-start" />
          {laterCount} put away for later
        </Button>
      )}
    </div>
  );
}

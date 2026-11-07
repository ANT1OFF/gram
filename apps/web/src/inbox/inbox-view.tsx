import { Dialog } from "@base-ui/react/dialog";
import {
  AlarmClock,
  Bell,
  CircleCheck,
  History,
  Inbox as InboxIcon,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { EmptyState, type EmptyAction } from "@/components/empty-state";
import { Hint } from "@/components/hint";
import { useHistoryStore } from "@/history/history-view";
import { Button } from "@/components/ui/button";
import { keyLabel } from "@/keyboard/registry";
import { formatRelative, formatWakeTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { focusIfConnected, focusLost, returnFocusTo, useOpener } from "@/lib/use-return-focus";
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
import { paneComposerNow } from "@/shell/pane-focus";
import { SideResizeHandle } from "@/shell/side-resize";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useNotificationHistory, unreadNotifications } from "@/stores/notifications";

import { InboxDetail } from "./inbox-detail";
import { useInboxDock } from "./inbox-dock";
import {
  INBOX_DOCKED,
  INBOX_LIST_COMPACT,
  INBOX_LIST_COMPACT_BELOW,
  INBOX_LIST_WIDTH,
  inboxListWidth,
  useInboxStore,
} from "./inbox-store";

// The Inbox: everything that needs the user, across every workspace, in one place. A list by kind
// (errors, approvals, questions, reviews, steps, drafts) with the category strip above it, and the
// picked item in a pane beside it with everything it takes to answer it. It docks in the side
// panel's column (`InboxDock`), beside the thread it answers for, which ⏎ shows in the main area;
// where the window has no room for it there, or Quiet covers the window, it is a dialog
// (`InboxView`). One Inbox either way: the same list, selection and keys. Every count in the window
// is this list's (`needsYouCounts`): the title bar's button, the sidebar's pill, each workspace's
// badge, the window title and the dock badge. Keys: j/k or ↓/↑ move, ⏎ opens the item's thread
// (docked, beside it), 1–9 pick, ⌘⏎ sends, ⌘Z takes the last answer back, esc closes.

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

/** The Inbox as a dialog: in Quiet, and where the window has no room to dock it. */
export function InboxView() {
  const docked = useInboxDock() !== undefined;
  const open = useInboxStore((s) => s.open) && !docked;
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
        <Dialog.Backdrop className="fixed inset-0 z-40 scrim transition-opacity duration-(--dur-fast) data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          data-testid={INBOX_TEST_ID}
          data-surface="overlay"
          aria-label="Inbox"
          // The list first, where j/k move; the Later list or the empty state has none.
          initialFocus={() =>
            document.querySelector<HTMLElement>('[data-testid="inbox-list"]') ?? true
          }
          // A thread just opened takes focus in its pane; a dismissal hands it back. Docked instead
          // (the window widened), the dock has it.
          finalFocus={() =>
            useInboxStore.getState().leftForThread || useInboxStore.getState().open
              ? false
              : returnFocusTo(opener)()
          }
          className="fixed top-[6%] left-1/2 z-50 flex h-[min(44rem,86vh)] w-[min(68rem,94vw)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-edge bg-popover text-popover-foreground shadow-overlay outline-none transition-[opacity,scale] duration-(--dur-fast) data-[ending-style]:scale-98 data-[ending-style]:opacity-0 data-[starting-style]:scale-98 data-[starting-style]:opacity-0"
        >
          {open && <InboxBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const CLOSE = {
  size: "icon-xs",
  variant: "ghost",
  "aria-label": "Close Inbox",
  title: "Close (esc)",
  "data-testid": "inbox-close",
} as const;

/** The dock's own keys: Esc closes it; Enter and Esc never reach the thread beside it. */
const onDockKey = (event: ReactKeyboardEvent<HTMLElement>) => {
  if (event.metaKey || event.ctrlKey || (event.key !== "Enter" && event.key !== "Escape")) return;
  // A plain Enter or Esc pressed here is the Inbox's, never the thread's beside it (its approval's
  // Allow and Deny), whether anything here takes it or not.
  event.stopPropagation();
  // Esc closes it from anywhere in it but a menu or popup it opened, which keeps its own.
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    event.altKey ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    !(event.target instanceof Node) ||
    !event.currentTarget.contains(event.target)
  ) {
    return;
  }
  event.preventDefault();
  useInboxStore.getState().close();
};

/** The focused pane's composer, beside the docked Inbox. */
const composer = () => paneComposerNow(useLayoutStore.getState().grid.focused);

/** The list, the strip, the detail and Later: where focus goes when the Inbox opens. */
const inboxStart = (root: ParentNode): HTMLElement | null =>
  root.querySelector<HTMLElement>('[data-testid="inbox-list"]');

/**
 * The Inbox docked in the side panel's column, beside the work: the shell draws it in the panel's
 * place while it is open and the window has room (`useInboxDock`). Opening it, or ⌘⇧I from the
 * thread beside it, puts focus on its list; Tab goes on to the detail; Esc closes it, handing focus
 * to the thread it showed (its composer) or else back to where it was opened from. A panel opened
 * meanwhile (its toggle, a tab, an agent's request) takes the column back.
 */
export function InboxDock() {
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Focus to the list on opening and on every open from outside it; what had focus is where Esc
  // goes back to.
  useEffect(() => {
    const take = () => {
      const dock = root.current;
      if (dock === null) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !dock.contains(active)) {
        opener.current = active;
      }
      (inboxStart(dock) ?? dock).focus();
    };
    take();
    return useInboxStore.subscribe((s, prev) => {
      if (s.focusTick !== prev.focusTick) take();
    });
  }, []);

  // Closed with focus inside (Esc, its close button, ⌘⇧I): focus goes to the thread it showed, else
  // back where it came from, else the composer, not to the page.
  useEffect(
    () => () => {
      const showed = useInboxStore.getState().leftForThread;
      setTimeout(() => {
        if (!focusLost()) return;
        if (showed && focusIfConnected(composer())) return;
        if (!focusIfConnected(opener.current)) focusIfConnected(composer());
      }, 0);
    },
    [],
  );

  // The panel's column is the Inbox's while it shows: a panel opened or switched meanwhile takes it
  // back, shown even where the toggle that asked for it found it hidden behind the Inbox.
  useEffect(
    () =>
      useLayoutStore.subscribe((s, prev) => {
        const asked =
          s.panelTab !== prev.panelTab ||
          s.panelOpen !== prev.panelOpen ||
          (s.panelPeek && !prev.panelPeek);
        if (!asked || !useInboxStore.getState().open) return;
        useInboxStore.getState().close();
        if (fitShell(s).panel === "none") s.revealPanel();
      }),
    [],
  );

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the keys of what is inside it
    <aside
      ref={root}
      onKeyDown={onDockKey}
      data-testid={INBOX_TEST_ID}
      data-docked=""
      data-surface="chrome"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col overflow-hidden border-l border-border bg-panel outline-none"
    >
      <div className="h-(--titlebar-height) shrink-0 [-webkit-app-region:drag]" />
      <InboxBody docked={titleId} />
    </aside>
  );
}

function InboxBody({
  docked: titleId,
}: {
  /**
   * Docked beside the work, its title's id: ⏎ shows the thread in the main area, and Esc is the
   * Inbox's own. Absent in the dialog, which titles and closes itself.
   */
  docked?: string;
}) {
  const docked = titleId !== undefined;
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
  // The request list beside the detail: compact (a line a request) or full, by its width, which
  // its divider drags and Compact list toggles.
  const listWidth = inboxListWidth(
    useInboxStore((s) => s.listWidth),
    docked,
  );
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
  // Docked, an item answered, put away or dismissed with a click takes the focused control with it,
  // and focus would fall to the page, where Esc and the keys are the thread's beside it: the list
  // has it back. Focus the user took elsewhere stays there. (The dialog keeps focus in itself.)
  const hadFocus = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!docked) return;
    const note = (event: Event) => {
      const dock = bodyRef.current?.closest(INBOX_DOCKED);
      hadFocus.current = event.target instanceof Node && dock?.contains(event.target) === true;
    };
    document.addEventListener("focusin", note, true);
    document.addEventListener("pointerdown", note, true);
    return () => {
      document.removeEventListener("focusin", note, true);
      document.removeEventListener("pointerdown", note, true);
    };
  }, [docked]);
  useEffect(() => {
    if (!docked || !hadFocus.current || !focusLost()) return;
    (listRef.current ?? bodyRef.current?.closest<HTMLElement>(INBOX_DOCKED))?.focus();
  });

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
    <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <InboxIcon aria-hidden className="size-icon-row text-muted-foreground" />
        {docked ? (
          <h2 id={titleId} className="text-title">
            Inbox
          </h2>
        ) : (
          <Dialog.Title className="text-title">Inbox</Dialog.Title>
        )}
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
                onClick={() =>
                  setListWidth(compact ? INBOX_LIST_WIDTH.default : INBOX_LIST_COMPACT)
                }
              />
            }
          >
            {compact ? <PanelLeftOpen aria-hidden /> : <PanelLeftClose aria-hidden />}
          </Hint>
        )}
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
        {docked ? (
          <Button {...CLOSE} onClick={() => useInboxStore.getState().close()}>
            <X aria-hidden />
          </Button>
        ) : (
          <Dialog.Close render={<Button {...CLOSE} />}>
            <X aria-hidden />
          </Dialog.Close>
        )}
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
        <div className="relative flex min-h-0 flex-1">
          {/* The detail keeps room for an answer's choices however wide the list is dragged. */}
          <div
            className="flex min-h-0 max-w-[calc(100%-18rem)] shrink-0 flex-col border-r border-border"
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
            {current !== undefined && (
              <InboxDetail item={current} now={now} docked={docked} onOpenThread={jump} />
            )}
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
      <NeedsYouUndo className="shrink-0 border-t border-border py-1" />
      <div
        data-testid="inbox-keys"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border px-3 py-1.5 text-meta text-muted-foreground"
      >
        <span>
          <kbd className="font-sans">j k</kbd> move
        </span>
        <span>
          <kbd className="font-sans">{keyLabel("⏎")}</kbd> {docked ? "show thread" : "open thread"}
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

/**
 * What a row says of its kind, in words, where neither its section's heading nor the rest of the
 * row already does: not "Approval" under Approvals, nor "Plan to review" when its title says it. A
 * question's heading says it, and its thread says who asks; an error's heading says it.
 */
const rowKind = (
  item: NeedsYouItem,
  section: NeedsYouSection,
  title: string,
): string | undefined => {
  if (item.kind === "question" || item.kind === "failure") return undefined;
  const label = kindOf(item).label;
  const heading = section.label.toLowerCase();
  const said = heading === label.toLowerCase() || heading === `${label.toLowerCase()}s`;
  return said || title.startsWith(label) ? undefined : label;
};

/**
 * One row of the list, two short lines: what it is about and how long ago, then its kind where the
 * heading doesn't say it, its workspace and its thread. The whole question, its choices and its
 * command's arguments are the detail pane's. A click shows it.
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
    rowKind(item, section, title),
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
      title={compact ? [title, where].filter(Boolean).join("\n") : undefined}
      onClick={onSelect}
      className={cn(
        "grid cursor-default items-start gap-x-2 rounded-(--radius-md) px-2",
        compact
          ? "min-h-7 grid-cols-[1rem_minmax(0,1fr)] py-1"
          : "min-h-9 grid-cols-[1rem_minmax(0,1fr)_auto] py-1.5",
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
        <span data-testid="inbox-item-title" className="truncate text-body">
          {title}
          {item.command !== undefined && (
            <>
              {" "}
              <code className="font-mono text-meta">{item.command}</code>
            </>
          )}
        </span>
        <span
          data-testid="inbox-item-where"
          className={cn(
            compact ? "sr-only" : "truncate text-meta text-muted-foreground",
            !item.owned && "italic",
          )}
        >
          {where}
        </span>
      </span>
      {!compact && item.at !== undefined && (
        <span className="text-meta leading-5 text-muted-foreground tabular-nums">
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
          icon: AlarmClock,
          onClick: () => useInboxStore.getState().setLater(true),
        }
      : {
          label: "Open History",
          icon: History,
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

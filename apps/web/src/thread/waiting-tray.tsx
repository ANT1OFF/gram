import {
  waitViewOf,
  type ThreadId,
  type WaitData,
  type WaitId,
  type WaitItem,
  type WaitNoteData,
  type WaitView,
  type WaitViewKind,
} from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  ExternalLink,
  Eye,
  Hand,
  Inbox,
  Locate,
  PenLine,
  Plus,
  Reply,
  ShieldQuestion,
  Sparkles,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

import { useApi } from "@/api/context";
import { openContentUrl } from "@/api/open-external";
import { Hint } from "@/components/hint";
import { formatClockTime, formatRelative } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { PulseOnce } from "@/motion";
import { copyText } from "@/settings/copy-text";
import { useDraftStore } from "@/stores/drafts";
import { readMessage } from "@/stores/feeds";
import { useLayoutStore } from "@/stores/layout";
import { useRevealStore } from "@/stores/reveal";
import { useThreadsStore } from "@/stores/threads";

import {
  copyTextOf,
  linkHost,
  noteShown,
  primaryAction,
  recentlyResolved,
  trayLabel,
  trayNames,
  trayViews,
  undoableHelperResolves,
  waitCount,
} from "./waiting-model";

const KIND: Record<WaitViewKind, { icon: LucideIcon; label: string }> = {
  draft: { icon: PenLine, label: "A draft to send" },
  review: { icon: Eye, label: "To review" },
  decision: { icon: CircleHelp, label: "A decision" },
  action: { icon: Hand, label: "A step only you can take" },
  question: { icon: CircleHelp, label: "A question" },
  approval: { icon: ShieldQuestion, label: "An approval" },
  plan: { icon: ShieldQuestion, label: "A plan to review" },
};

/** How long a row marked done offers Undo. */
const UNDO_MS = 10_000;

const report = (what: string) => (error: unknown) =>
  console.error(`waiting on you: ${what}`, error);

function Action({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  testId,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Hint
      label={label}
      render={
        <button
          type="button"
          aria-label={label}
          data-testid={testId}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
          className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        />
      }
    >
      <Icon aria-hidden className="size-3.5" />
    </Hint>
  );
}

function Row({
  threadId,
  view,
  item,
  now,
  onDone,
  onKeep,
  elsewhere = false,
}: {
  threadId: ThreadId;
  view: WaitView;
  item: WaitItem;
  now: number;
  onDone: (item: WaitItem) => void;
  /** Absent outside the thread's own tray, which alone lists a helper's suggestions. */
  onKeep?: ((item: WaitItem) => void) | undefined;
  /** Listed outside its thread, on the board: Jump to and Answer open the thread too. */
  elsewhere?: boolean;
}) {
  const api = useApi();
  const openAt = useOpenWait();
  const [expanded, setExpanded] = useState(false);
  /**
   * `fallback` when the whole history is in and the reply to copy from isn't, so the item's own text
   * went instead; `failed` when the reply couldn't be loaded, so nothing was copied.
   */
  const [copied, setCopied] = useState<"copied" | "fallback" | "failed" | undefined>(undefined);
  const rowRef = useRef<HTMLLIElement>(null);
  const kind = KIND[view.kind];
  const suggested = view.suggested === true;
  const primary = suggested ? undefined : primaryAction(view.kind);
  const KindIcon = suggested ? Sparkles : kind.icon;
  const kindLabel = suggested ? `Suggested by the helper: ${kind.label}` : kind.label;
  const host = item.link === undefined ? undefined : linkHost(item.link);
  const messageId = item.messageId;

  const copy = async () => {
    const message =
      item.copy === undefined && messageId !== undefined
        ? await readMessage(api, threadId, messageId).catch((error: unknown) => {
            setCopied("failed");
            throw error;
          })
        : undefined;
    await copyText(copyTextOf(item, message));
    setCopied(item.copy === undefined && message === undefined ? "fallback" : "copied");
    setTimeout(() => setCopied(undefined), 1500);
  };
  const answer = () => {
    const drafts = useDraftStore.getState();
    const current = drafts.text[threadId] ?? "";
    const quote = `> ${item.title}\n\n`;
    drafts.setText(threadId, current.trim() === "" ? quote : `${current}\n\n${quote}`);
    if (elsewhere) return openAt(threadId);
    requestAnimationFrame(() =>
      rowRef.current
        ?.closest("[data-pane-index]")
        ?.querySelector<HTMLElement>('textarea[aria-label="Message"]')
        ?.focus(),
    );
  };

  return (
    <li
      ref={rowRef}
      data-testid="waiting-item"
      data-kind={view.kind}
      data-suggested={suggested}
      className={cn(
        "group/item flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60",
        suggested && "border border-dashed border-border",
      )}
    >
      <Hint label={kindLabel} render={<span className="mt-0.5 flex shrink-0" />}>
        <KindIcon aria-hidden className="size-3.5 text-status-needs" />
        <span className="sr-only">{kindLabel}</span>
      </Hint>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">{view.title}</span>
          {suggested && (
            <span className="shrink-0 rounded-sm border border-dashed border-border px-1 text-[10px] text-muted-foreground">
              suggested
            </span>
          )}
          <span className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatRelative(view.createdAt, now)}
          </span>
        </span>
        {expanded ? (
          <span data-testid="waiting-item-detail" className="mt-0.5 flex flex-col gap-1 text-xs">
            {item.body !== undefined && (
              <span className="whitespace-pre-wrap text-muted-foreground">{item.body}</span>
            )}
            {item.copy !== undefined && (
              <span className="max-h-40 overflow-y-auto rounded-sm border border-border bg-background/60 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-foreground">
                {item.copy}
              </span>
            )}
            {host !== undefined && <span className="text-muted-foreground">Opens {host}</span>}
          </span>
        ) : (
          (view.preview ?? host) !== undefined && (
            <span className="block truncate text-xs text-muted-foreground">
              {view.preview ?? host}
            </span>
          )
        )}
      </button>
      <span className="flex shrink-0 items-center">
        {primary === "copy" && (
          <Action
            icon={copied === undefined || copied === "failed" ? Copy : Check}
            label={
              copied === "copied"
                ? "Copied"
                : copied === "fallback"
                  ? "Its reply is gone: copied the item's own text"
                  : copied === "failed"
                    ? "Couldn't load its reply; try again"
                    : "Copy the draft"
            }
            onClick={() => void copy().catch(report("copy"))}
            testId="waiting-copy"
          />
        )}
        {primary === "open" && item.link !== undefined && (
          <Action
            icon={ExternalLink}
            label={host === undefined ? "Open the link" : `Open ${host}`}
            onClick={() => void openContentUrl(api, item.link!).catch(report("open"))}
            testId="waiting-open"
          />
        )}
        {primary === "answer" && (
          <Action
            icon={Reply}
            label="Answer in the composer"
            onClick={answer}
            testId="waiting-answer"
          />
        )}
        {suggested && onKeep !== undefined && (
          <Action
            icon={Plus}
            label="Keep it in Waiting on you"
            onClick={() => onKeep(item)}
            testId="waiting-keep"
          />
        )}
        <Action
          icon={Locate}
          label={messageId === undefined ? "Not in the transcript" : "Jump to the message"}
          disabled={messageId === undefined}
          onClick={() => {
            if (elsewhere) openAt(threadId, messageId);
            else if (messageId !== undefined) useRevealStore.getState().reveal(threadId, messageId);
          }}
          testId="waiting-jump"
        />
        {suggested ? (
          <Action
            icon={X}
            label="Dismiss the suggestion"
            onClick={() => onDone(item)}
            testId="waiting-dismiss"
          />
        ) : (
          <Action icon={Check} label="Done" onClick={() => onDone(item)} testId="waiting-done" />
        )}
      </span>
    </li>
  );
}

/** An item's row, for the lists outside its thread. */
export { Row as WaitingItemRow };

/** Opens a thread from a list of what waits, scrolled to `messageId` when there is one. */
function useOpenWait(): (threadId: ThreadId, messageId?: string | undefined) => void {
  const navigate = useNavigate();
  return (threadId, messageId) => {
    if (messageId !== undefined) useRevealStore.getState().reveal(threadId, messageId);
    useLayoutStore.getState().openThread(threadId);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };
}

/**
 * The tray's last line: "Resolved (3)", the items resolved in the last day, unfolded to reopen one.
 * Read when the tray opens and again on each change to what is open; `hidden` are those whose Undo
 * still stands above it, the user's or the helper's.
 */
function ResolvedLine({
  threadId,
  openKey,
  hidden,
  now,
  onReopen,
}: {
  threadId: ThreadId;
  /** Changes with the open items, which every resolve and reopen changes too. */
  openKey: string;
  hidden: ReadonlySet<WaitId>;
  now: number;
  onReopen: (item: WaitItem) => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const all = useQuery({
    queryKey: ["thread.listWaits", threadId, "all", openKey],
    queryFn: () => api.listWaits(threadId, "all"),
    placeholderData: (previous) => previous,
  });
  const resolved = recentlyResolved(all.data ?? [], now).filter((item) => !hidden.has(item.id));
  if (resolved.length === 0) return null;
  return (
    <li data-testid="waiting-resolved" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 transition-transform duration-(--dur-fast)", open && "rotate-90")}
        />
        Resolved ({resolved.length})
      </button>
      {open && (
        <ul className="flex flex-col">
          {resolved.map((item) => (
            <li
              key={item.id}
              data-testid="waiting-resolved-item"
              className="flex items-center gap-2 px-2 py-1 pl-6 text-xs text-muted-foreground"
            >
              <Check aria-hidden className="size-3.5 shrink-0 text-success" />
              <span className="min-w-0 truncate line-through">{item.title}</span>
              <span className="shrink-0 tabular-nums">
                {item.resolvedBy === "agent" ? "by the agent · " : ""}
                {formatRelative(item.resolvedAt!, now)}
              </span>
              <button
                type="button"
                data-testid="waiting-reopen"
                onClick={() => onReopen(item)}
                className="ml-auto flex shrink-0 items-center gap-1 hover:text-foreground"
              >
                <Undo2 aria-hidden className="size-3" /> Reopen
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Under the pane header, above the plan strip: what this thread waits
 * on the user for, on one line with a light attention tint, folded until clicked. Opened, each item
 * has its kind, title, preview and age, with Copy, Open or Answer by kind, Jump to and Done; a row's
 * text expands it in place. Done offers Undo for a while, and the agent hears of it with the next
 * message; the last day's resolved items can be reopened from the Resolved line. A helper's
 * suggestion is dashed, uncounted, with Keep and Dismiss; what the helper resolved has an Undo of
 * its own for ten minutes. Absent while nothing waits.
 */
export function WaitingTray({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const [open, setOpen] = useState(false);
  const [undoable, setUndoable] = useState<readonly WaitItem[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const now = useNow(open || (summary?.helperResolved?.length ?? 0) > 0, undefined, 60_000);
  // An orchestrator's open questions are asks: its ask stack holds them, not the tray.
  const views = summary === undefined ? [] : trayViews(summary);
  const unfold = useTrayUnfold((s) => s.asked[threadId]);
  const [seenUnfold, setSeenUnfold] = useState<number | undefined>(undefined);
  if (unfold !== seenUnfold) {
    setSeenUnfold(unfold);
    if (unfold !== undefined) setOpen(true);
  }
  useEffect(() => {
    if (unfold !== undefined) useTrayUnfold.getState().taken(threadId, unfold);
  }, [threadId, unfold]);
  const count = waitCount(views);
  const additions = useAdditions(count);
  const byHelper = summary === undefined ? [] : undoableHelperResolves(summary, now);

  useEffect(() => {
    if (undoable.length === 0) return;
    const timer = setTimeout(() => setUndoable([]), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undoable]);

  if (
    summary === undefined ||
    (views.length === 0 && undoable.length === 0 && byHelper.length === 0)
  ) {
    return null;
  }
  const items = summary.waits ?? [];
  const openIds = new Set(items.map((item) => item.id));
  const done = (item: WaitItem) => {
    setUndoable((rows) => [...rows.filter((row) => row.id !== item.id), item]);
    void api.resolveWait(threadId, item.id).catch(report("done"));
  };
  const undo = (item: WaitItem) => {
    setUndoable((rows) => rows.filter((row) => row.id !== item.id));
    void api.resolveWait(threadId, item.id, true).catch((error: unknown) => {
      // Refused while the thread is full again: the item stays done, so its Undo comes back.
      setUndoable((rows) => [...rows, item]);
      report("undo")(error);
    });
  };
  const keep = (item: WaitItem) => void api.keepWait(threadId, item.id).catch(report("keep"));
  const reopen = (item: WaitItem) =>
    void api.resolveWait(threadId, item.id, true).catch(report("reopen"));
  const undone = undoable.filter((item) => !openIds.has(item.id));
  const names = trayNames(views.filter((view) => view.suggested !== true));
  const suggestions = views.length - count;

  return (
    <div
      data-testid="waiting-tray"
      data-open={open}
      className="@container shrink-0 border-b border-border bg-status-needs/[0.07]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={views.length === 0 ? "Nothing waits on you" : trayLabel(views)}
        onClick={() => setOpen(!open)}
        className="mx-auto flex h-8 w-full max-w-(--thread-max-width) items-center gap-2 px-6 text-xs text-muted-foreground hover:text-foreground @max-sm:px-3"
      >
        <PulseOnce trigger={additions} tone="needs">
          <Inbox aria-hidden className="size-3.5 text-status-needs" />
        </PulseOnce>
        <span data-testid="waiting-count" className="shrink-0 font-medium text-foreground">
          <span className="@max-sm:hidden">{count} waiting on you</span>
          <span className="hidden tabular-nums @max-sm:inline">{count}</span>
        </span>
        {names.length > 0 && (
          <span className="min-w-0 truncate @max-sm:hidden">· {names.join(" · ")}</span>
        )}
        {suggestions > 0 && (
          <span className="flex shrink-0 items-center gap-1 @max-sm:hidden">
            · <Sparkles aria-hidden className="size-3" /> {suggestions} suggested
          </span>
        )}
        {byHelper.length > 0 && (
          <span className="shrink-0 @max-sm:hidden">
            · {byHelper.length} resolved by the helper
          </span>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 transition-transform duration-(--dur-fast)",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        // Items and questions alike capped to a share of the pane and scrolled, as the plan strip is.
        <div className="max-h-[calc(var(--pane-height,100vh)*0.4)] overflow-y-auto">
          <ul
            aria-label="Waiting on you"
            className="mx-auto flex max-w-(--thread-max-width) flex-col gap-0.5 px-4 pb-2 @max-sm:px-1"
          >
            {items.map((item) => (
              <Row
                key={item.id}
                threadId={threadId}
                view={waitViewOf(threadId, item)}
                item={item}
                now={now}
                onDone={done}
                onKeep={keep}
              />
            ))}
            {undone.map((item) => (
              <li
                key={item.id}
                data-testid="waiting-undo-row"
                className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
              >
                <Check aria-hidden className="size-3.5 shrink-0 text-success" />
                <span className="min-w-0 truncate line-through">{item.title}</span>
                <button
                  type="button"
                  data-testid="waiting-undo"
                  onClick={() => undo(item)}
                  className="ml-auto flex shrink-0 items-center gap-1 hover:text-foreground"
                >
                  <Undo2 aria-hidden className="size-3" /> Undo
                </button>
              </li>
            ))}
            {byHelper.length > 0 && (
              <li data-testid="waiting-helper-resolved" className="px-2 pt-1 text-xs">
                <button
                  type="button"
                  aria-expanded={showResolved}
                  onClick={() => setShowResolved(!showResolved)}
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <Sparkles aria-hidden className="size-3" />
                  Resolved by the helper from what you wrote ({byHelper.length})
                  <ChevronDown
                    aria-hidden
                    className={cn("size-3 transition-transform", showResolved && "rotate-180")}
                  />
                </button>
                {showResolved && (
                  <ul className="mt-0.5 flex flex-col">
                    {byHelper.map((item) => (
                      <li
                        key={item.id}
                        data-testid="waiting-helper-resolved-item"
                        className="flex items-center gap-2 py-1 text-muted-foreground"
                      >
                        <Check aria-hidden className="size-3.5 shrink-0 text-success" />
                        <span className="min-w-0 truncate line-through">{item.title}</span>
                        <span className="shrink-0 tabular-nums">
                          {formatRelative(item.resolvedAt!, now)}
                        </span>
                        <button
                          type="button"
                          data-testid="waiting-helper-undo"
                          onClick={() => reopen(item)}
                          className="ml-auto flex shrink-0 items-center gap-1 hover:text-foreground"
                        >
                          <Undo2 aria-hidden className="size-3" /> Undo
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )}
            <ResolvedLine
              threadId={threadId}
              openKey={items.map((item) => `${item.id}:${item.revision ?? 0}`).join(",")}
              hidden={new Set([...undone, ...byHelper].map((item) => item.id))}
              now={now}
              onReopen={reopen}
            />
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Asks a thread's tray to unfold: the workspace head's badge opens the orchestrator with its tray
 * open. An ask waits until a tray of that thread takes it, since the pane may not be open yet.
 */
export const useTrayUnfold = create<{
  readonly asked: Readonly<Record<string, number>>;
  readonly unfold: (threadId: ThreadId) => void;
  /** The tray has unfolded for the ask `nonce`; a newer one is kept. */
  readonly taken: (threadId: ThreadId, nonce: number) => void;
}>((set) => ({
  asked: {},
  unfold: (threadId) => set((s) => ({ asked: { ...s.asked, [threadId]: Date.now() } })),
  taken: (threadId, nonce) =>
    set((s) => {
      if (s.asked[threadId] !== nonce) return {};
      const { [threadId]: _taken, ...rest } = s.asked;
      return { asked: rest };
    }),
}));

/** How many times `count` has gone up, so the tray pulses for an item added and not one done. */
function useAdditions(count: number): number {
  const [seen, setSeen] = useState({ count, additions: 0 });
  if (count === seen.count) return seen.additions;
  const next = { count, additions: seen.additions + (count > seen.count ? 1 : 0) };
  setSeen(next);
  return next.additions;
}

/**
 * Where `wait_on_user` added an item, in the transcript: one muted line naming it, which says when
 * it was done, or that a later update moved it.
 */
export function WaitChip({ wait }: { wait: WaitData }) {
  const state =
    wait.state === "done"
      ? `Done${wait.resolvedAt === undefined ? "" : ` ${formatClockTime(wait.resolvedAt)}`}`
      : wait.state === "revised"
        ? "Updated later"
        : undefined;
  return (
    <div
      data-testid="wait-chip"
      data-state={wait.state}
      className="my-1.5 flex w-fit max-w-full items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Inbox
        aria-hidden
        className={cn("size-3.5 shrink-0", wait.state === "open" && "text-status-needs")}
      />
      <span className="min-w-0 truncate">
        Waiting on you:{" "}
        <span className={cn("text-foreground", wait.state !== "open" && "line-through")}>
          {wait.title}
        </span>
      </span>
      {state !== undefined && <span className="shrink-0">· {state}</span>}
    </div>
  );
}

/**
 * Under a user message: that Gram told the agent what the user changed in Waiting on you
 * with it, as a muted line that unfolds to the note as the agent read it.
 */
export function WaitNoteLine({ note }: { note: WaitNoteData }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="wait-note" className="flex max-w-full flex-col items-end gap-1 text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <Inbox aria-hidden className="size-3" />
        Gram told the agent
        <ChevronRight
          aria-hidden
          className={cn("size-3 transition-transform duration-(--dur-fast)", open && "rotate-90")}
        />
      </button>
      {open && (
        <p
          data-testid="wait-note-text"
          className="max-w-prose rounded-sm border border-border px-2 py-1 whitespace-pre-wrap text-muted-foreground"
        >
          {noteShown(note.text)}
        </p>
      )}
    </div>
  );
}

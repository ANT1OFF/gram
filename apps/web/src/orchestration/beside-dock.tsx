import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { ChevronRight, Maximize2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { keyLabel } from "@/keyboard/registry";
import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { SegmentSlab, Swap } from "@/motion";
import { DiffPanel } from "@/panels/diff-panel";
import { useOpenThread } from "@/shell/thread-switcher";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";
import { ReadOnlyTranscript } from "@/thread/read-only-transcript";
import { ThreadView } from "@/thread/thread-view";

import { checkRestored, closeBeside, useBesideStore, type BesideTab } from "./beside-store";
import { lastCommandOf, type LastCommand } from "./last-command";
import { WorkerNowChip } from "./worker-header";

const BESIDE_TEST_ID = "beside-dock";

const TABS: readonly { readonly id: BesideTab; readonly label: string }[] = [
  { id: "thread", label: "Conversation" },
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
];

const ICON_BUTTON =
  "grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Keeps a worker restored from storage only while it is still a worker of the orchestrator in
 * view, and closes it once the worker is gone. Mounted with the thread page, as the panel isn't
 * while hidden.
 */
export function useBesideSync() {
  const worker = useBesideStore((s) => s.worker);
  const restored = useBesideStore((s) => s.restored);
  const known = useThreadsStore((s) =>
    worker === undefined ? false : s.byId[worker] !== undefined,
  );
  const ready = useThreadsStore((s) => s.ready);
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  useEffect(() => {
    if (ready && restored) checkRestored(route);
  }, [ready, restored, route]);
  // A worker closed while open beside the chat goes with it, and so does one opened in full.
  useEffect(() => {
    if (worker !== undefined && ready && !known) closeBeside();
  }, [worker, ready, known]);
  // Only on arriving there: ⌘\ opens the worker in view beside the chat before the route has left it.
  const lastRoute = useRef(route);
  useEffect(() => {
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    if (route !== undefined && useBesideStore.getState().worker === route) closeBeside();
  }, [route]);
}

/**
 * The right panel's Thread tab: a worker beside its orchestrator's chat (⌘\, ⌘-click a worker, or
 * a plain click on its link in the chat). Its Thread view is the worker's own transcript and
 * composer, and what you send there is you typing into the worker, so the rules for that apply as
 * they do in its own view; Terminal and Changes only read. Opening it leaves the keyboard the
 * orchestrator composer's: the view takes keys once you click or tab into it.
 */
export function BesidePanel({ worker }: { worker: ThreadId }) {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const detail = useThreadsStore((s) => s.statusDetail[worker]);
  const tab = useBesideStore((s) => s.tab);
  const setTab = useBesideStore((s) => s.setTab);
  const focused = useBesideStore((s) => s.focused);
  const setFocused = useBesideStore((s) => s.setFocused);
  const open = useOpenThread();
  const group = useId();
  const root = useRef<HTMLDivElement>(null);
  // Its keys while focus or the last press is in it; a press anywhere else gives them back.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node | null)) setFocused(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      setFocused(false);
    };
  }, [setFocused]);
  if (summary === undefined) return null;
  const { thread } = summary;
  const display = threadStatusOf(summary, detail);
  return (
    <div
      ref={root}
      data-testid={BESIDE_TEST_ID}
      data-thread-id={worker}
      data-focused={focused}
      aria-label={`Beside the chat: ${thread.title}`}
      role="region"
      className="flex min-h-0 flex-1 flex-col bg-thread"
      onPointerDownCapture={() => setFocused(true)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <header className="@container flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3 text-reading">
        <Swap swapKey={display.label}>
          <display.icon
            aria-hidden
            data-working={display.working}
            className={cn("size-icon-row shrink-0", display.tone)}
          />
        </Swap>
        <span className="sr-only">{display.label}: </span>
        <span className="shrink-0 text-muted-foreground">Thread</span>
        <ChevronRight aria-hidden className="size-icon-chip shrink-0 text-muted-foreground" />
        <span
          data-testid="beside-title"
          title={thread.title}
          className="min-w-0 truncate font-heading font-medium"
        >
          {thread.title}
        </span>
        {/* The title first: what it is doing drops where both don't fit. */}
        <span className="flex shrink-0 @max-md:hidden">
          <WorkerNowChip thread={thread} />
        </span>
        <span className="flex-1" />
        <Hint
          label="Open full view"
          side="bottom"
          render={
            <button
              type="button"
              aria-label="Open full view"
              data-testid="beside-open"
              className={ICON_BUTTON}
              onClick={() => {
                closeBeside();
                open(worker);
              }}
            />
          }
        >
          <Maximize2 aria-hidden className="size-icon-row" />
        </Hint>
        <Hint
          label={keyLabel("Close (⌘\\)")}
          side="bottom"
          render={
            <button
              type="button"
              aria-label="Close"
              data-testid="beside-close"
              className={ICON_BUTTON}
              onClick={closeBeside}
            />
          }
        >
          <X aria-hidden className="size-icon-row" />
        </Hint>
      </header>
      <div
        role="tablist"
        aria-label="What to show"
        className="isolate flex shrink-0 items-center gap-0.5 border-b border-border px-3 py-1.5 text-meta"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`beside-tab-${id}`}
            // Picking a view leaves the keyboard where it was.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setTab(id)}
            className={cn(
              "relative rounded-sm px-2 py-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              tab === id && "text-foreground",
            )}
          >
            {tab === id && <SegmentSlab group={group} className="rounded-sm bg-muted" />}
            <span className="relative">{label}</span>
          </button>
        ))}
      </div>
      {tab === "thread" && (
        <ThreadView key={worker} threadId={worker} focused={focused} beside={{ header: null }} />
      )}
      {tab === "terminal" && <LiveTerminal threadId={worker} />}
      {tab === "changes" && (
        <ReadOnlyTranscript.Provider value>
          <div className="flex min-h-0 flex-1 flex-col">
            <DiffPanel key={worker} threadId={worker} />
          </div>
        </ReadOnlyTranscript.Provider>
      )}
    </div>
  );
}

/** Within this many pixels of its bottom the terminal counts as following. */
const FOLLOW_SLACK = 24;

const TERMINAL_PILL =
  "absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge bg-popover px-2.5 py-1 text-meta shadow-raised";

/**
 * The worker's terminal: its newest command, its output growing as the transcript brings it in. It
 * only reads: no input, never the focus, and nothing in it reaches the worker.
 */
function LiveTerminal({ threadId }: { threadId: ThreadId }) {
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const background = useThreadsStore((s) => s.byId[threadId]?.background);
  const backgroundCalls = useMemo(
    () => new Set((background ?? []).flatMap((task) => task.toolCallId ?? [])),
    [background],
  );
  // A background shell's output comes beside the transcript, its call having had its result.
  const backgroundOutput = useThreadsStore((s) => s.byId[threadId]?.backgroundOutput);
  const outputByCall = useMemo(
    () =>
      new Map(
        (backgroundOutput ?? []).flatMap((each) =>
          each.toolCallId === undefined ? [] : [[each.toolCallId, each.output] as const],
        ),
      ),
    [backgroundOutput],
  );
  const last = useMemo(
    () => lastCommandOf(messages, backgroundCalls, outputByCall),
    [messages, backgroundCalls, outputByCall],
  );
  if (last === undefined) {
    return (
      <p className="px-4 py-6 text-center text-reading text-muted-foreground">No command yet</p>
    );
  }
  // A new command opens at its bottom, followed.
  return <CommandView key={last.toolCallId} last={last} />;
}

/** One command and its output: kept at the bottom while you are there, put while you scroll up. */
function CommandView({ last }: { last: LastCommand }) {
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const [behind, setBehind] = useState(false);
  const { output } = last;
  // More output takes the view down with it, as a terminal does, unless you scrolled up to read.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
    // `output` is the signal, not an input: each time it grows, a following view goes down with it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [output]);
  const follow = () => {
    following.current = true;
    setBehind(false);
    const element = ref.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  };
  const status = last.running
    ? "Running"
    : last.failed
      ? "Failed"
      : last.exitCode !== undefined && last.exitCode !== 0
        ? `Exited ${last.exitCode}`
        : "Done";
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <pre
        ref={ref}
        data-testid="beside-terminal"
        data-tool-call-id={last.toolCallId}
        data-running={last.running}
        aria-label="Terminal output"
        onScroll={(event) => {
          const element = event.currentTarget;
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK;
          following.current = atBottom;
          setBehind(!atBottom);
        }}
        className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-12 font-mono text-meta leading-relaxed whitespace-pre-wrap text-foreground/90"
      >
        <span className="text-muted-foreground">$ </span>
        {last.command}
        {last.output === "" ? "" : `\n${last.output}`}
      </pre>
      {!last.running ? (
        <span
          data-testid="beside-terminal-status"
          className={cn(
            "absolute right-3 bottom-3 rounded-sm bg-popover px-1.5 py-0.5 text-meta",
            status === "Done" ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {status}
        </span>
      ) : behind ? (
        <button
          type="button"
          data-testid="beside-terminal-jump"
          // The keyboard stays the orchestrator composer's.
          onMouseDown={(event) => event.preventDefault()}
          onClick={follow}
          className={cn(
            TERMINAL_PILL,
            "text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-status-working" />
          Jump to live
        </button>
      ) : (
        <span
          role="status"
          data-testid="beside-terminal-live"
          className={cn(TERMINAL_PILL, "text-muted-foreground")}
        >
          <span aria-hidden className="gram-breathe size-1.5 rounded-full bg-status-working" />
          Following live
        </span>
      )}
    </div>
  );
}

import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { Maximize2, X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Hint } from "@/components/hint";
import { cn } from "@/lib/utils";
import { SegmentSlab, Swap, useMotionLevel, usePresetTransition } from "@/motion";
import { DiffPanel } from "@/panels/diff-panel";
import { useOpenThread } from "@/shell/thread-switcher";
import { threadStatusOf } from "@/sidebar/status";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";
import { useSplitSubagents } from "@/thread/use-split-subagents";
import { ReadOnlyTranscript } from "@/thread/read-only-transcript";
import { activeStreamingIds } from "@/thread/streaming";
import { Transcript } from "@/thread/transcript";

import { checkRestored, closeBeside, useBesideStore, type BesideTab } from "./beside-store";
import { lastCommandOf, type LastCommand } from "./last-command";
import { WorkerNowChip } from "./worker-header";

const BESIDE_DOCK_TEST_ID = "beside-dock";

const TABS: readonly { readonly id: BesideTab; readonly label: string }[] = [
  { id: "log", label: "Log" },
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
];

const NO_TURN_ENDS = new Map();

const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The worker kept beside the orchestrator's chat (⌘\): its log, its terminal and its changes,
 * to watch while you talk. It only reads, has no composer and never takes focus, so docking a worker
 * leaves it the orchestrator's and the keyboard the orchestrator composer's. ⌘\ or Close undocks it.
 */
export function BesideDock() {
  const worker = useBesideStore((s) => s.worker);
  const known = useThreadsStore((s) =>
    worker === undefined ? false : s.byId[worker] !== undefined,
  );
  const ready = useThreadsStore((s) => s.ready);
  const restored = useBesideStore((s) => s.restored);
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  const level = useMotionLevel();
  const preset = usePresetTransition("snappy");
  // A dock brought back by a reload shows once its worker is still the orchestrator's in view.
  useEffect(() => {
    if (ready && restored) checkRestored(route);
  }, [ready, restored, route]);
  // A worker closed while docked leaves the dock with it.
  useEffect(() => {
    if (worker !== undefined && ready && !known) closeBeside();
  }, [worker, ready, known]);
  const width = "min(30rem, 42%)";
  const closed = level === "full" ? { width: 0, opacity: 0 } : { width, opacity: 0 };
  const transition =
    level === "off" ? { duration: 0 } : level === "full" ? preset : { duration: 0.12 };
  return (
    <AnimatePresence initial={false}>
      {worker !== undefined && known && !restored && (
        <m.aside
          key="beside"
          data-testid={BESIDE_DOCK_TEST_ID}
          data-thread-id={worker}
          aria-label="Kept beside"
          initial={closed}
          animate={{ width, opacity: 1 }}
          exit={closed}
          transition={transition}
          className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-thread"
        >
          <DockBody worker={worker} />
        </m.aside>
      )}
    </AnimatePresence>
  );
}

function DockBody({ worker }: { worker: ThreadId }) {
  const summary = useThreadsStore((s) => s.byId[worker]);
  const detail = useThreadsStore((s) => s.statusDetail[worker]);
  const tab = useBesideStore((s) => s.tab);
  const setTab = useBesideStore((s) => s.setTab);
  const open = useOpenThread();
  const group = useId();
  if (summary === undefined) return null;
  const { thread } = summary;
  const display = threadStatusOf(summary, detail);
  return (
    <>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3 text-sm">
        <Swap swapKey={display.label}>
          <display.icon
            aria-hidden
            data-working={display.working}
            className={cn("size-3.5 shrink-0", display.tone)}
          />
        </Swap>
        <span className="sr-only">{display.label}: </span>
        <span data-testid="beside-title" className="min-w-0 truncate font-heading font-medium">
          {thread.title}
        </span>
        <WorkerNowChip thread={thread} />
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
          <Maximize2 aria-hidden className="size-3.5" />
        </Hint>
        <Hint
          label="Close (⌘\)"
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
          <X aria-hidden className="size-3.5" />
        </Hint>
      </header>
      <div
        role="tablist"
        aria-label="What to watch"
        className="isolate flex shrink-0 items-center gap-0.5 border-b border-border px-3 py-1.5 text-xs"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`beside-tab-${id}`}
            // Choosing what to watch leaves the keyboard the orchestrator composer's.
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
      <ReadOnlyTranscript.Provider value>
        {tab === "log" && <WorkerLog key={worker} threadId={worker} />}
        {tab === "terminal" && <LiveTerminal threadId={worker} />}
        {tab === "changes" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <DiffPanel key={worker} threadId={worker} />
          </div>
        )}
      </ReadOnlyTranscript.Provider>
    </>
  );
}

/** The worker's transcript, followed live, with nothing in it that acts on the worker. */
function WorkerLog({ threadId }: { threadId: ThreadId }) {
  const status = useThreadsStore((s) => s.byId[threadId]?.status);
  const phase = useThreadFeed(threadId, (s) => s.phase);
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const streamingIds = useThreadFeed(threadId, (s) => s.streamingMessageIds);
  const { top, children, subagentUsage } = useSplitSubagents(messages);
  const nested = useMemo(
    () => new Set([...children.values()].flatMap((list) => list.map((message) => message.id))),
    [children],
  );
  const streaming = useMemo(
    () => activeStreamingIds(status, streamingIds, nested),
    [status, streamingIds, nested],
  );
  return (
    <Transcript
      threadId={threadId}
      loading={phase === "loading"}
      messages={top}
      subagents={children}
      subagentUsage={subagentUsage}
      streamingIds={streaming}
      turnEnds={NO_TURN_ENDS}
      animate={false}
      jump={undefined}
      live
    />
  );
}

/** Within this many pixels of its bottom the terminal counts as following. */
const FOLLOW_SLACK = 24;

const TERMINAL_PILL =
  "absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-popover px-2.5 py-1 text-xs shadow-sm";

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
    return <p className="px-4 py-6 text-center text-sm text-muted-foreground">No command yet</p>;
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
        className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-12 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground/90"
      >
        <span className="text-muted-foreground">$ </span>
        {last.command}
        {last.output === "" ? "" : `\n${last.output}`}
      </pre>
      {!last.running ? (
        <span
          data-testid="beside-terminal-status"
          className={cn(
            "absolute right-3 bottom-3 rounded-sm bg-popover px-1.5 py-0.5 text-xs",
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

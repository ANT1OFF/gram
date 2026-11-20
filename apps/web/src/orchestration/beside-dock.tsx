import type { ThreadId } from "@gram/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef } from "react";

import { useFollowBottom } from "@/lib/use-follow-bottom";
import { cn } from "@/lib/utils";
import { useThreadFeed } from "@/stores/feeds";
import { fitShell, useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";

import { checkRestored, closeBeside, useBesideStore } from "./beside-store";
import { lastCommandOf, type LastCommand } from "./last-command";

/**
 * Keeps a worker restored from storage only while it is still a worker of the orchestrator in
 * view, and closes it once the worker is gone. Mounted with the thread page, as the panel isn't
 * while hidden.
 */
export function useBesideSync() {
  const worker = useBesideStore((s) => s.worker);
  const restored = useBesideStore((s) => s.restored);
  const record = useBesideStore((s) => s.record);
  const known = useThreadsStore((s) =>
    worker === undefined ? false : s.byId[worker] !== undefined,
  );
  // The pane's current worker is the one last open in it, until the pane closes.
  const paneShown = useLayoutStore((s) => fitShell(s).panel !== "none");
  useEffect(() => {
    if (!paneShown && useBesideStore.getState().current !== undefined) {
      useBesideStore.setState({ current: undefined });
    }
  }, [paneShown]);
  const ready = useThreadsStore((s) => s.ready);
  const route = useParams({ strict: false }).threadId as ThreadId | undefined;
  useEffect(() => {
    if (ready && restored) checkRestored(route);
  }, [ready, restored, route]);
  // A worker closed while open beside the chat goes with it, and so does one opened in full.
  useEffect(() => {
    if (worker !== undefined && ready && !known && !record) closeBeside();
  }, [worker, ready, known, record]);
  // Only on arriving there: ⌘\ opens the worker in view beside the chat before the route has left it.
  const lastRoute = useRef(route);
  useEffect(() => {
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    if (route !== undefined && useBesideStore.getState().worker === route) closeBeside();
  }, [route]);
}

const TERMINAL_PILL =
  "absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge bg-popover px-2.5 py-1 text-meta shadow-raised";

/**
 * The worker's terminal: its newest command, its output growing as the transcript brings it in. It
 * only reads: no input, never the focus, and nothing in it reaches the worker.
 */
export function LiveTerminal({ threadId }: { threadId: ThreadId }) {
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
  const { ref, behind, onScroll, follow } = useFollowBottom<HTMLPreElement>(last.output);
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
        onScroll={onScroll}
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

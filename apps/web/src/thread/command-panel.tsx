import { ArrowDown, Check, CircleX, Square, X, type LucideIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Hint } from "@/components/hint";
import { useFollowBottom } from "@/lib/use-follow-bottom";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { Spinner, Swap } from "@/motion";
import { PanelMessage } from "@/panels/panel-message";
import { useThreadFeed } from "@/stores/feeds";
import { useThreadsStore } from "@/stores/threads";

import {
  commandSnapshot,
  stateLabel,
  type CommandState,
  type OpenCommand,
} from "./command-view-model";
import { useCommandViewStore } from "./command-view-store";
import { CopyButton, StopButton } from "./subagent-strip";
import { formatElapsed } from "./subagent-strip-model";
import { useSplitSubagents } from "./use-split-subagents";
import { useStopTask } from "./use-stop-task";

const NONE: readonly never[] = [];

const STATE_ICON: Record<CommandState, { icon: LucideIcon; tone: string }> = {
  running: { icon: Spinner, tone: "text-status-working" },
  done: { icon: Check, tone: "text-success" },
  failed: { icon: CircleX, tone: "text-destructive" },
  stopped: { icon: Square, tone: "text-muted-foreground" },
};

const ICON_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The right panel's Command tab: one command the agent ran, opened from its line above the
 * composer. Its whole command, wrapped, where it ran when the agent says, how long it has run and
 * how it ended, and its output as it comes, followed at the bottom unless you scroll up to read. It
 * only reads: Stop is the strip's Stop, and nothing else reaches the agent.
 */
export function CommandPanel({ open }: { open: OpenCommand }) {
  const { threadId } = open;
  const messages = useThreadFeed(threadId, (s) => s.messages);
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const { subagentUsage } = useSplitSubagents(messages);
  const background = summary?.background ?? NONE;
  const backgroundOutput = summary?.backgroundOutput ?? NONE;
  const snapshot = useMemo(
    () => commandSnapshot({ open, messages, background, backgroundOutput, usage: subagentUsage }),
    [open, messages, background, backgroundOutput, subagentUsage],
  );
  const running = snapshot.state === "running";
  // What it last wrote stays once it ends, though the tail read back for a background shell goes
  // with its task when the thread's summary is next fetched.
  const [kept, setKept] = useState(snapshot.output);
  if (snapshot.output !== "" && snapshot.output !== kept) setKept(snapshot.output);
  const output = snapshot.output === "" ? kept : snapshot.output;
  // The agent reports no end time: the clock holds still from its last tick before the end.
  const root = useRef<HTMLDivElement>(null);
  const now = useNow(running && open.startedAt !== undefined, root);
  const elapsed = open.startedAt === undefined ? undefined : formatElapsed(now - open.startedAt);
  const stopTask = useStopTask(threadId);
  const canStop = summary?.capabilities?.stopTasks === true;
  const close = useCommandViewStore((s) => s.close);
  const { ref, behind, onScroll, follow } = useFollowBottom<HTMLPreElement>(output);
  const label = stateLabel(snapshot);
  const mark = STATE_ICON[snapshot.state];
  const claude = summary?.thread.model.agent === "claude";

  return (
    <div
      ref={root}
      data-testid="command-view"
      data-thread-id={threadId}
      data-state={snapshot.state}
      role="region"
      aria-label="Command"
      className="flex min-h-0 flex-1 flex-col"
    >
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3 text-reading">
        <Swap swapKey={snapshot.state}>
          <mark.icon aria-hidden className={cn("size-icon-row shrink-0", mark.tone)} />
        </Swap>
        <span data-testid="command-view-state" className="shrink-0 font-medium">
          {label}
        </span>
        {elapsed !== undefined && (
          <span
            data-testid="command-view-elapsed"
            className="shrink-0 text-muted-foreground tabular-nums"
          >
            <span className="sr-only">{running ? "for " : "after "}</span>
            {elapsed}
          </span>
        )}
        <span className="flex-1" />
        <CopyButton command={snapshot.command} testId="command-view-copy" />
        {running && canStop && open.taskId !== undefined && snapshot.background && (
          <StopButton
            taskId={open.taskId}
            label={snapshot.command}
            onStop={stopTask}
            testId="command-view-stop"
          />
        )}
        <Hint
          label="Close"
          side="bottom"
          render={
            <button
              type="button"
              aria-label="Close"
              data-testid="command-view-close"
              className={ICON_BUTTON}
              onClick={close}
            />
          }
        >
          <X aria-hidden className="size-icon-row" />
        </Hint>
      </header>
      <div className="max-h-40 shrink-0 overflow-y-auto border-b border-border px-3 py-2">
        <pre
          data-testid="command-view-command"
          className="font-mono text-meta leading-relaxed wrap-anywhere whitespace-pre-wrap text-foreground"
        >
          <span aria-hidden className="text-muted-foreground select-none">
            ${" "}
          </span>
          {snapshot.command}
        </pre>
        {snapshot.cwd !== undefined && (
          <p
            data-testid="command-view-cwd"
            title={snapshot.cwd}
            className="mt-1 truncate font-mono text-meta text-muted-foreground"
          >
            <span className="sr-only">In </span>
            {snapshot.cwd}
          </p>
        )}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {output === "" ? (
          <PanelMessage>
            <span data-testid="command-view-empty" className="flex flex-col gap-1">
              {running ? "No output yet" : "No output"}
              {running && claude && (
                <span className="text-meta">
                  Claude Code shares a running command's output every few seconds. Where it can't,
                  the output shows here once the command ends.
                </span>
              )}
            </span>
          </PanelMessage>
        ) : (
          <pre
            ref={ref}
            data-testid="command-view-output"
            aria-label="Output"
            tabIndex={0}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-auto px-3 pt-2 pb-12 font-mono text-meta leading-relaxed wrap-anywhere whitespace-pre-wrap text-foreground/90 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
          >
            {output}
          </pre>
        )}
        {behind && output !== "" && (
          <button
            type="button"
            data-testid="command-view-jump"
            onClick={follow}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-edge bg-popover px-2.5 py-1 text-meta text-foreground shadow-raised outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowDown aria-hidden className="size-icon-chip" />
            {running ? "Jump to live" : "Jump to end"}
          </button>
        )}
      </div>
    </div>
  );
}

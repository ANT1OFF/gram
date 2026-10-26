import type { BackgroundTaskKind } from "@gram/contracts";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  Layers,
  Plug,
  Route,
  Square,
  SquareChevronRight,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { ShortcutKbd, useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { DrawnCheck, PresenceItem, PresenceList, Swap } from "@/motion";

import {
  formatElapsed,
  HINT_ROWS,
  rowHint,
  STRIP_ROWS,
  type RunningSubagent,
  type StripRow,
} from "./subagent-strip-model";
import { COPIED_MS, copyMarkdown } from "./message-actions";

const ROW =
  "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-border bg-card px-2 text-xs hover:bg-muted/60";
const JUMP =
  "flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const CHIP = "shrink-0 rounded-sm border border-border px-1 text-muted-foreground";

/** A glyph per kind of work, so the strip says what each line is without a word for it. */
const WORK_ICON: Record<BackgroundTaskKind, LucideIcon> = {
  subagent: Bot,
  shell: SquareChevronRight,
  workflow: Route,
  mcp: Plug,
  other: Layers,
};

const KIND_WORD: Record<BackgroundTaskKind, string> = {
  subagent: "Subagent",
  shell: "Background shell",
  workflow: "Workflow",
  mcp: "MCP task",
  other: "Background task",
};

/**
 * What the thread has running besides its turn, one line each above the composer, the most recent
 * first: its subagents at work and the shells and other tasks the agent left in the background. More
 * than `STRIP_ROWS` fold into one "N running" line, which opens to list them all. A subagent's line
 * jumps to its card, as ⌥⌘J does, and a background task's has Stop, and Copy for its whole command.
 * Empty, it takes no room. Its clock is its own, so the elapsed times tick without the transcript
 * re-rendering, and it holds still while the pane is out of sight.
 */
export function SubagentStrip({
  rows,
  onJump,
  onStop,
}: {
  rows: readonly StripRow[];
  onJump: (run: RunningSubagent) => void;
  onStop: (taskId: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(
    rows.some((row) => row.startedAt !== undefined),
    ref,
  );
  const hint = useShortcutHint("subagent.jump");
  const [open, setOpen] = useState(false);
  const folded = rows.length > STRIP_ROWS;
  const newest = rows[0];
  const firstJump = rows.find((row) => row.jump !== undefined);
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div
      ref={ref}
      data-testid="subagent-strip"
      // Shrinks before the composer does: in a short pane an open list scrolls rather than push it out.
      className="@container mx-auto flex min-h-0 w-full max-w-(--thread-max-width) shrink flex-col px-6"
    >
      <ul
        aria-label="Running in the background"
        className={cn("min-h-0 overflow-y-auto", folded && open && "max-h-40")}
      >
        <PresenceList>
          {folded && newest && (
            <PresenceItem as="li" key="folded" className="pb-1.5">
              <Hint
                label={<WorkHint rows={rows} now={now} />}
                render={
                  <button
                    type="button"
                    data-testid="subagent-strip-folded"
                    aria-expanded={open}
                    className={cn(
                      ROW,
                      "text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    )}
                    onClick={() => setOpen(!open)}
                  />
                }
              >
                <Layers aria-hidden className="size-3 shrink-0 text-status-working" />
                <span className="shrink-0 font-medium">{rows.length} running</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {open ? "" : newest.label}
                </span>
                <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground" />
              </Hint>
            </PresenceItem>
          )}
          {(!folded || open) &&
            rows.map((row) => {
              const Icon = WORK_ICON[row.kind];
              return (
                <PresenceItem as="li" key={row.key} className="pb-1.5">
                  <div
                    data-testid="subagent-strip-row"
                    data-kind={row.kind}
                    data-tool-call-id={row.jump?.toolCallId}
                    className={ROW}
                  >
                    <Jump
                      run={row.jump}
                      onJump={onJump}
                      label={
                        row.jump === undefined ? (
                          <WorkHint rows={[row]} now={undefined} named />
                        ) : (
                          withHint("Running. Jump to its card", row === firstJump ? hint : "")
                        )
                      }
                    >
                      <Icon aria-hidden className="size-3 shrink-0 text-status-working" />
                      <span className="sr-only">{KIND_WORD[row.kind]}, running:</span>
                      <span
                        className={cn(
                          "min-w-0 shrink truncate",
                          row.command ? "font-mono text-[11px]" : "font-medium",
                        )}
                      >
                        {row.label}
                      </span>
                      {row.chip && <span className={CHIP}>{row.chip}</span>}
                      <span className="min-w-0 flex-1 truncate text-muted-foreground @max-sm:hidden">
                        {row.note}
                      </span>
                      {row.startedAt !== undefined && (
                        <span
                          data-testid="subagent-elapsed"
                          className="ml-auto shrink-0 text-muted-foreground tabular-nums"
                        >
                          <span className="sr-only">for </span>
                          {formatElapsed(now - row.startedAt)}
                        </span>
                      )}
                      {row === firstJump && (
                        <ShortcutKbd
                          id="subagent.jump"
                          className="shrink-0 text-muted-foreground @max-sm:hidden"
                        />
                      )}
                    </Jump>
                    {row.command !== undefined && <CopyButton command={row.command} />}
                    {row.taskId !== undefined && (
                      <StopButton taskId={row.taskId} label={row.label} onStop={onStop} />
                    )}
                  </div>
                </PresenceItem>
              );
            })}
        </PresenceList>
      </ul>
    </div>
  );
}

/**
 * What the lines stand for, as a tooltip: each one's purpose, the start of its command in code, and
 * how long it has run when `now` is given. The folded line's names the first few and counts the rest.
 */
function WorkHint({
  rows,
  now,
  named = false,
}: {
  rows: readonly StripRow[];
  now: number | undefined;
  /** Say what kind of work a line is when nothing describes it, as a lone line's tooltip does. */
  named?: boolean;
}) {
  const more = rows.length - HINT_ROWS;
  return (
    // One line per title and command, so six rows and the count stand about 250px tall, well inside
    // the 600px a window can shrink to: a tooltip can't scroll, so its list mustn't need to.
    <ul className="flex max-h-[min(20rem,calc(var(--available-height)-1rem))] min-w-0 flex-col gap-1 overflow-hidden text-left">
      {rows.slice(0, more > 1 ? HINT_ROWS : rows.length).map((row) => {
        const hint = rowHint(row);
        const title = hint.title || (named ? KIND_WORD[row.kind] : undefined);
        const { command } = hint;
        const elapsed = now === undefined ? "" : elapsedText(row, now);
        return (
          <li key={row.key} className="min-w-0">
            <span className="flex items-baseline justify-between gap-3">
              {title ? (
                <span className="min-w-0 truncate">{title}</span>
              ) : command ? (
                code(command)
              ) : (
                <span className="min-w-0 truncate">{KIND_WORD[row.kind]}</span>
              )}
              {elapsed && <span className="shrink-0 tabular-nums opacity-70">{elapsed}</span>}
            </span>
            {title && command && code(command)}
          </li>
        );
      })}
      {more > 1 && <li className="opacity-70">and {more} more</li>}
    </ul>
  );
}

const code = (text: string) => (
  <code className="block min-w-0 truncate font-mono text-[11px] opacity-80">{text}</code>
);

/** Copies a task's whole command, which the line and its tooltip show only the start of. */
function CopyButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? "Copied" : "Copy command";
  return (
    <Hint
      label={label}
      render={
        <button
          type="button"
          data-testid="subagent-strip-copy"
          aria-label={label}
          onClick={() => {
            void copyMarkdown(command).then((ok) => setCopied(ok));
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      }
    >
      <Swap swapKey={copied ? "copied" : "copy"}>
        {copied ? (
          <DrawnCheck className="size-3 text-success" />
        ) : (
          <Copy aria-hidden className="size-3" />
        )}
      </Swap>
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </Hint>
  );
}

/** A line's body: a button that jumps to the card where there is one, plain otherwise. */
function Jump({
  run,
  onJump,
  label,
  children,
}: {
  run: RunningSubagent | undefined;
  onJump: (run: RunningSubagent) => void;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <Hint
      label={label}
      render={
        run === undefined ? (
          <span className={JUMP} />
        ) : (
          <button type="button" className={JUMP} onClick={() => onJump(run)} />
        )
      }
    >
      {children}
    </Hint>
  );
}

/** Stops one background task; the line goes when the agent reports it gone. */
function StopButton({
  taskId,
  label,
  onStop,
}: {
  taskId: string;
  label: string;
  onStop: (taskId: string) => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  return (
    <Hint
      label="Stop"
      render={
        <button
          type="button"
          data-testid="subagent-strip-stop"
          aria-label={`Stop ${label}`}
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            onStop(taskId).catch(() => setStopping(false));
          }}
          className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
      }
    >
      <Square aria-hidden className="size-2.5 fill-current" />
    </Hint>
  );
}

const elapsedText = (row: StripRow, now: number) =>
  row.startedAt === undefined ? "" : formatElapsed(now - row.startedAt);

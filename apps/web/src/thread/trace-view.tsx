import type { GramUIMessage, SubagentUsage, ThreadId } from "@gram/contracts";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleX,
  MessageSquare,
  ShieldQuestion,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatClockTime, formatLogTime } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { compactTokens } from "@/usage/usage-model";

import { useAwaitingToolIds } from "./awaiting-tools";
import { toolNameOf } from "./parts";
import { replyTokens } from "./reply-tokens-model";
import { formatElapsed } from "./subagent-strip-model";
import {
  offsetLabel,
  traceTurns,
  turnTrace,
  type Trace,
  type TraceKind,
  type TraceStep,
} from "./trace-model";
import { tookLabel, turnReplies } from "./turn-timeline-model";

// What a step is, by colour and glyph: the model is the accent, a tool is neutral, a worker is
// the merged purple, time waiting on the person is the needs colour. A failure is the danger
// colour whatever it is.
const KIND: Readonly<
  Record<TraceKind, { bar: string; text: string; icon: LucideIcon; name: string }>
> = {
  model: {
    bar: "bg-primary",
    text: "text-link",
    icon: Sparkles,
    name: "Model",
  },
  tool: {
    bar: "bg-muted-foreground/70",
    text: "text-muted-foreground",
    icon: Wrench,
    name: "Tools",
  },
  worker: {
    bar: "bg-merged",
    text: "text-merged",
    icon: Workflow,
    name: "Worker",
  },
  wait: {
    bar: "bg-status-needs-mark",
    text: "text-status-needs",
    icon: ShieldQuestion,
    name: "Waiting on you",
  },
};

const barOf = (step: TraceStep) =>
  step.tone === "failed"
    ? "bg-destructive"
    : step.tone === "stopped"
      ? "bg-muted-foreground/35"
      : KIND[step.kind].bar;

const ROW = "grid grid-cols-[clamp(9rem,38%,20rem)_3.5rem_minmax(0,1fr)] items-center gap-3 px-4";

/** As much of a call's output as the detail shows; the conversation has the rest. */
const OUTPUT_MAX = 6_000;

const textOf = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
};

const clip = (text: string) =>
  text.length > OUTPUT_MAX
    ? `${text.slice(0, OUTPUT_MAX)}\n… cut here, the rest is in the conversation`
    : text;

/**
 * A thread's trace, in place of its conversation: one turn's steps as a tree with a bar each on one
 * time axis, a worker's own steps under it, and the selected step's detail beside them. Read from
 * the thread's loaded messages, and again each second while the turn runs.
 */
export function TraceView({
  threadId,
  messages,
  subagents,
  subagentUsage,
  turn: wanted,
  working,
  onTurn,
  onClose,
  onReveal,
}: {
  threadId: ThreadId;
  /** The thread's top-level messages. */
  messages: readonly GramUIMessage[];
  subagents: ReadonlyMap<string, readonly GramUIMessage[]>;
  subagentUsage: ReadonlyMap<string, SubagentUsage>;
  /** The turn to show; absent for the latest turn that made a tool call. */
  turn: string | undefined;
  /** The thread's agent is at work, so its last turn has no end yet. */
  working: boolean;
  onTurn: (turn: string) => void;
  onClose: () => void;
  /** Shows a message in the conversation. */
  onReveal: (messageId: string) => void;
}) {
  const turns = useMemo(() => traceTurns(messages), [messages]);
  const at = Math.max(
    0,
    wanted === undefined
      ? turns.findLastIndex((turn) => turn.tools > 0)
      : turns.findIndex((turn) => turn.id === wanted),
  );
  const turn = turns[at];
  const last = at === turns.length - 1;
  const { replies, startedAt } = useMemo(
    () =>
      turn === undefined ? { replies: [], startedAt: undefined } : turnReplies(messages, turn.id),
    [messages, turn],
  );
  const endedAt = replies.at(-1)?.metadata?.turnEnd?.at;
  // An older turn with no recorded end stopped where the next one started, or at its last call.
  const running = last && working && endedAt === undefined;
  const root = useRef<HTMLDivElement>(null);
  const now = useNow(running, root);
  const awaiting = useAwaitingToolIds(threadId);
  const trace = useMemo(
    () =>
      turnTrace(
        replies,
        subagents,
        subagentUsage,
        turn?.startedAt ?? startedAt,
        running ? undefined : (endedAt ?? turns[at + 1]?.startedAt),
        now,
        awaiting,
      ),
    [
      replies,
      subagents,
      subagentUsage,
      turn,
      startedAt,
      running,
      endedAt,
      turns,
      at,
      now,
      awaiting,
    ],
  );
  // The step picked, and the turn it was picked in: another turn starts with none.
  const [pick, setPick] = useState<{ turn: string | undefined; id: string } | undefined>();
  const picked = pick?.turn === turn?.id ? pick?.id : undefined;
  const setPicked = (id: string) => setPick({ turn: turn?.id, id });
  // A turn opens on what went wrong in it, when something did.
  const selected =
    trace?.steps.find((step) => step.id === picked) ??
    (picked === undefined ? trace?.steps.find((step) => step.tone === "failed") : undefined);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    const node = root.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [onClose]);
  const tokens = replyTokens(replies.at(-1)?.metadata?.usage);

  return (
    <div
      ref={root}
      data-testid="trace-view"
      data-thread={threadId}
      className="flex min-h-0 flex-1 flex-col bg-background text-meta"
    >
      <div className="@container/tracetop flex shrink-0 items-center gap-2 border-b border-border px-4 py-1.5">
        <Button variant="ghost" size="sm" data-testid="trace-close" onClick={onClose}>
          <ArrowLeft aria-hidden data-icon="inline-start" />
          Conversation
        </Button>
        <span className="font-medium text-foreground">Trace</span>
        <span className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            title="Earlier turn"
            aria-label="Earlier turn"
            data-testid="trace-turn-earlier"
            disabled={at <= 0}
            onClick={() => onTurn(turns[at - 1]!.id)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          {/* One line at any width: a phone's bar keeps the turn and drops when it started. */}
          <span
            data-testid="trace-turn"
            className="whitespace-nowrap text-muted-foreground tabular-nums"
          >
            {turn === undefined ? (
              "No turns"
            ) : (
              <>
                Turn {turn.number} of {turns.length}
                {turn.startedAt !== undefined && (
                  <span className="@max-md/tracetop:hidden">
                    {" · "}
                    {formatClockTime(turn.startedAt)}
                  </span>
                )}
              </>
            )}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Later turn"
            aria-label="Later turn"
            data-testid="trace-turn-later"
            disabled={at >= turns.length - 1}
            onClick={() => onTurn(turns[at + 1]!.id)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </span>
      </div>
      {trace === undefined ? (
        <p data-testid="trace-empty" className="px-4 py-6 text-muted-foreground">
          {turn === undefined || turn.tools === 0
            ? "This turn made no tool calls, so there is nothing to trace: the model answered in one go."
            : "No timings for this turn: its tool calls ran before Gram recorded them."}
        </p>
      ) : (
        <>
          <Summary trace={trace} running={running} tokens={tokens?.total} />
          <div className="@container/trace flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col @4xl/trace:flex-row">
              <Waterfall trace={trace} selected={selected?.id} onSelect={setPicked} />
              <aside
                data-testid="trace-detail"
                className="flex max-h-[45%] shrink-0 flex-col gap-3 overflow-y-auto border-t border-border bg-panel px-4 py-3 @4xl/trace:max-h-none @4xl/trace:w-88 @4xl/trace:border-t-0 @4xl/trace:border-l"
              >
                {selected === undefined ? (
                  <Overview trace={trace} tokens={tokens} />
                ) : (
                  <Detail step={selected} trace={trace} onReveal={onReveal} />
                )}
              </aside>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Summary({
  trace,
  running,
  tokens,
}: {
  trace: Trace;
  running: boolean;
  tokens: number | undefined;
}) {
  const { wallMs, modelMs, toolMs, waitMs } = trace.totals;
  const shares: readonly (readonly [TraceKind, number])[] = [
    ["model", modelMs],
    ["tool", toolMs],
    ["wait", waitMs],
  ];
  return (
    <div className="@container/tracesum shrink-0 border-b border-border">
      <div
        data-testid="trace-summary"
        className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2 text-muted-foreground"
      >
        <span>
          <b className="font-semibold text-foreground tabular-nums">{formatElapsed(wallMs)}</b>{" "}
          {running ? "so far" : `finished ${formatClockTime(trace.end)}`}
        </span>
        {/* Between the total and its parts where they fit on one row; under them in a narrow view,
          where it squeezed the parts onto a second row. */}
        <span
          aria-hidden
          className="flex h-1.5 min-w-32 gap-0.5 overflow-hidden rounded-full @max-2xl/tracesum:order-last @max-2xl/tracesum:basis-full @2xl/tracesum:flex-1"
        >
          {shares.map(
            ([kind, ms]) =>
              ms > 0 && (
                <span
                  key={kind}
                  className={cn("rounded-full", KIND[kind].bar)}
                  style={{ flexGrow: ms, flexBasis: 0 }}
                />
              ),
          )}
        </span>
        {shares.map(
          ([kind, ms]) =>
            (ms > 0 || kind !== "wait") && (
              <span
                key={kind}
                data-testid={`trace-total-${kind}`}
                className="flex items-center gap-1.5"
              >
                <span aria-hidden className={cn("size-2 rounded-xs", KIND[kind].bar)} />
                {KIND[kind].name}
                <b className="font-semibold text-foreground tabular-nums">{tookLabel(ms)}</b>
              </span>
            ),
        )}
        {tokens !== undefined && (
          <span>
            <b className="font-semibold text-foreground tabular-nums">{compactTokens(tokens)}</b>{" "}
            tokens
          </span>
        )}
        {trace.failed > 0 && (
          <span data-testid="trace-failed" className="text-destructive">
            {trace.failed} failed
          </span>
        )}
      </div>
    </div>
  );
}

function Waterfall({
  trace,
  selected,
  onSelect,
}: {
  trace: Trace;
  selected: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div
        aria-hidden
        className={cn(
          ROW,
          "h-7 shrink-0 border-b border-border text-caption text-muted-foreground",
        )}
      >
        <span>Step</span>
        <span>Took</span>
        <span className="relative h-full tabular-nums">
          {trace.ticks.map((tick) => (
            <span
              key={tick.at}
              className="absolute inset-y-0 flex items-center border-l border-border pl-1"
              style={{ left: `${tick.at}%` }}
            >
              {tick.label}
            </span>
          ))}
        </span>
      </div>
      <ol data-testid="trace-steps" className="min-h-0 flex-1 overflow-y-auto py-1">
        {trace.steps.map((step) => {
          const kind = KIND[step.kind];
          const Icon = step.tone === "failed" ? CircleX : kind.icon;
          return (
            <li key={step.id}>
              <button
                type="button"
                data-testid="trace-step"
                data-kind={step.kind}
                data-tone={step.tone}
                data-depth={step.depth}
                aria-pressed={selected === step.id}
                onClick={() => onSelect(step.id)}
                className={cn(
                  ROW,
                  "h-7 w-full text-left outline-none hover:bg-accent focus-visible:bg-accent aria-pressed:bg-accent",
                )}
              >
                <span
                  className="flex min-w-0 items-center gap-1.5"
                  style={{ paddingLeft: `${step.depth * 1.125}rem` }}
                >
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-icon-row shrink-0",
                      step.tone === "failed" ? "text-destructive" : kind.text,
                    )}
                  />
                  <span title={step.label} className="truncate text-foreground">
                    {step.label}
                  </span>
                  {step.note !== undefined && (
                    <span className="shrink truncate text-muted-foreground">{step.note}</span>
                  )}
                </span>
                {/* A call held at its approval card says so where its time will be. */}
                {step.kind === "wait" && step.tone === "running" ? (
                  <span data-testid="trace-step-waits" className={cn("text-caption", kind.text)}>
                    Waiting
                  </span>
                ) : (
                  <span className="text-caption text-muted-foreground tabular-nums">
                    {step.took ?? (step.tone === "running" ? "…" : "")}
                  </span>
                )}
                <span className="relative h-full">
                  {trace.ticks.map((tick) => (
                    <span
                      key={tick.at}
                      aria-hidden
                      className="absolute inset-y-0 border-l border-border/60"
                      style={{ left: `${tick.at}%` }}
                    />
                  ))}
                  {step.left !== undefined && (
                    <span
                      className={cn(
                        "absolute top-2 h-3 min-w-0.75 rounded-xs",
                        barOf(step),
                        step.tone === "running" && "motion-safe:animate-pulse",
                      )}
                      style={{ left: `${step.left}%`, width: `${step.width}%` }}
                    />
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {trace.untimed > 0 && (
        <p className="shrink-0 border-t border-border px-4 py-1.5 text-muted-foreground">
          {trace.untimed === 1 ? "1 call has" : `${trace.untimed} calls have`} no recorded time.
        </p>
      )}
    </div>
  );
}

const Fact = ({ name, children }: { name: string; children: React.ReactNode }) => (
  <>
    <dt className="text-muted-foreground">{name}</dt>
    <dd className="min-w-0 text-foreground tabular-nums wrap-anywhere">{children}</dd>
  </>
);

const Code = ({ name, text, testid }: { name: string; text: string; testid: string }) => (
  <div className="flex flex-col gap-1">
    <span className="text-caption text-muted-foreground">{name}</span>
    <pre
      data-testid={testid}
      className="max-h-72 overflow-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-caption whitespace-pre-wrap wrap-anywhere text-foreground"
    >
      {text}
    </pre>
  </div>
);

/** With no step selected: what the turn's tokens were, and how to read the bars. */
function Overview({ trace, tokens }: { trace: Trace; tokens: ReturnType<typeof replyTokens> }) {
  const calls = trace.steps.filter((step) => step.kind !== "model").length;
  return (
    <>
      <h3 className="text-body font-medium text-foreground">This turn</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        <Fact name="Steps">
          {calls} {calls === 1 ? "call" : "calls"}
          {trace.failed > 0 ? `, ${trace.failed} failed` : ""}
        </Fact>
        {tokens?.rows.map((row) => (
          <Fact key={row.key} name={row.label}>
            {row.value}
          </Fact>
        ))}
      </dl>
      <p className="text-muted-foreground">
        Select a step for what it was given and what came back. The model is not timed call by call:
        its bars are the time between tool calls.
      </p>
    </>
  );
}

function Detail({
  step,
  trace,
  onReveal,
}: {
  step: TraceStep;
  trace: Trace;
  onReveal: (messageId: string) => void;
}) {
  const part = step.part;
  const command =
    part === undefined
      ? undefined
      : typeof (part.input as { command?: unknown } | undefined)?.command === "string"
        ? (part.input as { command: string }).command
        : textOf(part.input);
  const output =
    part === undefined
      ? undefined
      : part.state === "output-error"
        ? part.errorText
        : part.state === "output-available"
          ? textOf(part.output)
          : undefined;
  const beside = trace.steps.filter(
    (other) =>
      other !== step &&
      other.depth === step.depth &&
      other.kind !== "model" &&
      step.kind !== "model" &&
      other.startedAt !== undefined &&
      step.startedAt !== undefined &&
      other.startedAt < (step.endedAt ?? trace.end) &&
      (other.endedAt ?? trace.end) > step.startedAt,
  );
  const state =
    step.tone === "failed"
      ? "Failed"
      : step.tone === "stopped"
        ? "Stopped"
        : step.kind === "wait"
          ? "Waiting on you"
          : step.tone === "running"
            ? "Running"
            : undefined;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h3
          data-testid="trace-detail-title"
          className="min-w-0 text-body font-medium wrap-anywhere text-foreground"
        >
          {step.label}
        </h3>
        {state !== undefined && (
          <Badge variant={step.tone === "failed" ? "destructive" : "secondary"}>{state}</Badge>
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
        {step.startedAt !== undefined && (
          <Fact name="Started">
            {formatLogTime(step.startedAt)}, {offsetLabel(step.startedAt - trace.start)} into the
            turn
          </Fact>
        )}
        {step.took !== undefined && <Fact name="Took">{step.took}</Fact>}
        {part !== undefined && step.kind !== "worker" && (
          <Fact name="Tool">{toolNameOf(part)}</Fact>
        )}
        {step.model !== undefined && <Fact name="Model">{step.model}</Fact>}
        {step.kind === "worker" && step.note !== undefined && <Fact name="Agent">{step.note}</Fact>}
        {step.calls !== undefined && step.calls > 0 && <Fact name="Calls">{step.calls}</Fact>}
        {step.usage?.totalTokens !== undefined && (
          <Fact name="Tokens">{compactTokens(step.usage.totalTokens)}</Fact>
        )}
        {beside.length > 0 && (
          <Fact name="Ran beside">{beside.map((other) => other.label).join(", ")}</Fact>
        )}
      </dl>
      {step.kind === "model" && (
        <p className="text-muted-foreground">
          The model thinking and writing between tool calls. Its calls are not timed one by one, and
          tokens are counted for the whole turn.
        </p>
      )}
      {command !== undefined && (
        <Code name="Input" text={clip(command)} testid="trace-detail-input" />
      )}
      {output !== undefined && (
        <Code
          name={part?.state === "output-error" ? "Error" : "Output"}
          text={clip(output)}
          testid="trace-detail-output"
        />
      )}
      {step.messageId !== undefined && (
        <div>
          <Button
            variant="outline"
            size="sm"
            data-testid="trace-reveal"
            onClick={() => onReveal(step.messageId!)}
          >
            <MessageSquare aria-hidden data-icon="inline-start" />
            Show in conversation
          </Button>
        </div>
      )}
    </>
  );
}

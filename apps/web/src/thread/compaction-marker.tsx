import type { CompactionActivity, CompactionData, IdleCompactNotice } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FoldVertical } from "lucide-react";
import { useRef, useState } from "react";

import { Hint } from "@/components/hint";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { dateTimeFormat } from "@/lib/intl";
import { CLOCK_TIME } from "@/lib/time";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { Spinner } from "@/motion/spinner";

import { IDLE_COMPACT_ANCHOR } from "@/settings/idle-compact-field";

import { formatElapsed } from "./subagent-strip-model";

const TOKENS = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 });
const DATE = { day: "numeric", month: "short" } as const;

/**
 * The marker's line: `Context compacted · 14:32 · 182K → 24K tokens`. The time is alone when it was
 * today and follows the date when not; a side the agent didn't report is left out. `intl` pins the
 * locale and zone, for tests.
 */
export const compactionLabel = (
  compaction: CompactionData,
  now: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): string => compactionParts(compaction, now, intl).join(" · ");

/**
 * `compactionLabel` in its two halves, what happened and when, then the tokens, so a narrow thread
 * can put the tokens on a line of their own rather than cut them off.
 */
export const compactionParts = (
  compaction: CompactionData,
  now: number,
  intl: { readonly locale?: string; readonly timeZone?: string } = {},
): readonly string[] => {
  const zone = intl.timeZone === undefined ? {} : { timeZone: intl.timeZone };
  const format = (at: number, options: Intl.DateTimeFormatOptions) =>
    dateTimeFormat(intl.locale, { ...options, ...zone }).format(at);
  const { at, preTokens: pre, postTokens: post } = compaction;
  const when =
    at === undefined
      ? undefined
      : format(
          at,
          format(at, DATE) === format(now, DATE) ? CLOCK_TIME : { ...DATE, ...CLOCK_TIME },
        );
  const tokens =
    pre !== undefined && post !== undefined
      ? `${TOKENS.format(pre)} → ${TOKENS.format(post)} tokens`
      : pre !== undefined
        ? `from ${TOKENS.format(pre)} tokens`
        : post !== undefined
          ? `to ${TOKENS.format(post)} tokens`
          : undefined;
  const what =
    compaction.reason !== "idle"
      ? "Context compacted"
      : compaction.outcome === "failed"
        ? "Idle compaction failed"
        : compaction.outcome === "unknown"
          ? "Idle compaction · outcome unknown"
          : "Context compacted · idle, before cache expiry";
  const head = when === undefined ? what : `${what} · ${when}`;
  return tokens === undefined ? [head] : [head, tokens];
};

/** Who started it, for the tooltip: the line itself reads the same either way. */
const TRIGGER: Record<CompactionData["trigger"], string> = {
  manual:
    "Compacted on request (/compact): the agent carries on from a summary of the conversation.",
  auto: "The agent compacted the conversation to make room in its context window, and carries on from a summary of it.",
};

/** Gram's idle compaction, by how it ended, for the tooltip and the details' first line. */
const IDLE: Record<NonNullable<CompactionData["outcome"]>, string> = {
  completed:
    "Gram compacted this idle thread just before its prompt cache expired, so its next wake starts from a summary instead of rewriting the whole conversation.",
  failed:
    "Gram asked the agent to compact this idle thread before its cache expired, and it failed.",
  unknown:
    "Gram asked the agent to compact this idle thread before its cache expired; the agent ended without saying whether it did.",
};

const why = (compaction: CompactionData): string =>
  compaction.reason === "idle"
    ? IDLE[compaction.outcome ?? "completed"]
    : TRIGGER[compaction.trigger];

const ROW = "flex w-full items-center gap-3 text-xs text-muted-foreground";

/**
 * The live line's words: `Compacting context…`, how long it has taken, and the context it started
 * from when the agent said: `Compacting context… · 12s · from 182K tokens`.
 */
export const compactingParts = (compaction: CompactionActivity, now: number): readonly string[] => [
  "Compacting context…",
  formatElapsed(now - compaction.startedAt),
  ...(compaction.preTokens === undefined
    ? []
    : [`from ${TOKENS.format(compaction.preTokens)} tokens`]),
];

/** `compactingParts` by position: the clock's text changes every second, its place doesn't. */
const PART_KEYS = ["what", "elapsed", "tokens"] as const;

/** The status glyph's hint while the thread compacts, short for a row or a header. */
export const compactingLabel = (compaction: CompactionActivity): string =>
  compaction.trigger === "manual"
    ? "Compacting context (/compact)"
    : compaction.trigger === "auto"
      ? "Compacting context to make room"
      : "Compacting context";

/** The live line's hint: who started it, and what it does. */
const compactingTitle = (compaction: CompactionActivity): string =>
  compaction.trigger === "manual"
    ? "Compacting on request (/compact): the agent is replacing the conversation with a summary of it."
    : compaction.trigger === "auto"
      ? "The agent is compacting the conversation to make room in its context window."
      : "The agent is replacing the conversation with a summary of it, to make room in its context window.";

/**
 * A compaction under way, at the end of the transcript where its marker will appear: the marker's
 * hairline with the one spinner and a running clock. It holds still under Reduced and Off motion,
 * as the spinner does; the clock ticks under any.
 */
export function CompactingLine({ compaction }: { compaction: CompactionActivity }) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true, ref);
  const parts = compactingParts(compaction, now);
  return (
    <div
      ref={ref}
      role="status"
      title={compactingTitle(compaction)}
      data-testid="compacting"
      className={cn("my-3", ROW)}
    >
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <Spinner aria-hidden className="size-3 shrink-0 text-status-working" />
        <span className="sr-only">Compacting context</span>
        <span
          aria-hidden
          className="flex min-w-0 flex-wrap justify-center gap-x-1.5 text-center tabular-nums"
        >
          {parts.map((part, index) => (
            <span key={PART_KEYS[index]} className="whitespace-nowrap">
              {index > 0 && " · "}
              {part}
            </span>
          ))}
        </span>
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </div>
  );
}

/**
 * Where the agent compacted the conversation, as a quiet divider at the point it happened. Opens
 * to the provider's retained summary or an explanation when this history has no supplied summary.
 */
export function CompactionMarker({ compaction }: { compaction: CompactionData }) {
  // Only to tell today from another day, so read once rather than on a clock.
  const now = useNow(false);
  const [open, setOpen] = useState(false);
  const parts = compactionParts(compaction, now);
  const summary = compaction.summary?.trim() ? compaction.summary : undefined;
  const hint = `${open ? "Hide" : "Show"} compaction details. ${why(compaction)}`;
  const idle = compaction.reason === "idle";
  const ended = idle && compaction.outcome !== undefined && compaction.outcome !== "completed";
  const line = (
    <>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
      <span className="flex min-w-0 items-center gap-1.5">
        <FoldVertical aria-hidden className="size-3 shrink-0" />
        <span className="flex min-w-0 flex-wrap justify-center gap-x-1.5 text-center">
          {parts.map((part, index) => (
            <span key={part} className="whitespace-nowrap">
              {index > 0 && " · "}
              {part}
            </span>
          ))}
        </span>
        <ChevronRight
          aria-hidden
          className="size-3 shrink-0 transition-transform group-data-[panel-open]:rotate-90"
        />
      </span>
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border" />
    </>
  );
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="compaction" className="my-3">
      <Hint
        label={hint}
        render={
          <CollapsibleTrigger
            title={hint}
            className={cn(
              "group rounded-sm py-1 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-9",
              ROW,
            )}
          />
        }
      >
        {line}
      </Hint>
      <CollapsibleContent className="gram-collapse">
        <div
          data-testid="compaction-details"
          className="mt-2 rounded-(--radius-md) bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        >
          <p className="mb-2 font-medium">
            {idle
              ? "Idle compaction"
              : compaction.trigger === "manual"
                ? "Manual compaction"
                : "Automatic compaction"}
            {compaction.outcome === "failed"
              ? " · Failed"
              : compaction.outcome === "unknown"
                ? " · Outcome unknown"
                : " · Completed"}
          </p>
          {idle && (
            <p className="mb-2" data-testid="compaction-idle">
              {why(compaction)}{" "}
              {compaction.workspaceId !== undefined && (
                <Link
                  to="/settings/workspaces/$workspaceId"
                  params={{ workspaceId: compaction.workspaceId }}
                  hash={IDLE_COMPACT_ANCHOR}
                  data-testid="compaction-setting"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Idle compaction setting
                </Link>
              )}
            </p>
          )}
          {ended ? null : summary === undefined ? (
            <>
              <p className="font-medium">Summary not provided</p>
              <p className="mt-1">
                Compaction completed, but the resulting summary was not supplied by the agent or
                saved in this history.
              </p>
            </>
          ) : (
            <>
              <p className="mb-1 font-medium">Resulting summary</p>
              <p
                data-testid="compaction-summary"
                role="region"
                aria-label="Compaction summary"
                tabIndex={0}
                className="max-h-80 overflow-y-auto wrap-anywhere whitespace-pre-wrap focus-visible:outline-2 focus-visible:outline-ring"
              >
                {summary}
              </p>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What Gram sent the agent to compact an idle thread: a quiet line where a user's bubble would be. */
export const idleCompactRequestText = (notice: IdleCompactNotice): string =>
  `Gram asked the agent to compact this idle thread before its cache expires · ${TOKENS.format(notice.contextTokens)} tokens`;

export function IdleCompactRequest({ notice }: { notice: IdleCompactNotice }) {
  return (
    <p data-testid="idle-compact-request" className={cn("my-1 justify-center", ROW)}>
      <FoldVertical aria-hidden className="size-3 shrink-0" />
      <span className="text-center">{idleCompactRequestText(notice)}</span>
    </p>
  );
}

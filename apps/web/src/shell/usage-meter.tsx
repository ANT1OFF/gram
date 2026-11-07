import { limitForecast } from "@gram/contracts";
import { Link } from "@tanstack/react-router";
import { ChartNoAxesCombined, TrendingUp } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { agentLabel } from "@/agents/agent-label";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { PulseOnce } from "@/motion";
import {
  currentLimit,
  LIMIT_PROVIDERS,
  LIMIT_WINDOWS,
  limitStale,
  limitTone,
  limitWarns,
  nextLimitChange,
  shownLimit,
  useUsageLimits,
  type LimitProvider,
  type LimitWindow,
  type ShownLimit,
  type UsageLimit,
  type UsageLimits,
} from "@/stores/usage-limits";
import {
  CREDITS_TEXT,
  creditsText,
  forecastText,
  limitPercent,
  meterHint,
  meterLabel,
  meterSource,
  meterText,
  METER_RULE,
  resetAtText,
  WINDOW_LABEL,
} from "@/usage/limit-format";

import { clearRightEdge } from "./clear-of-cards";
import { TitlebarPopover } from "./titlebar-popover";

/**
 * `Date.now()` as of the last render that needed it, moved on when the soonest reading expires, so
 * one that ran out leaves the meter, or turns stale, so the meter dims.
 */
export function useLimitsNow(limits: UsageLimits): number {
  const [now, setNow] = useState(Date.now);
  const at = nextLimitChange(limits, now);
  useEffect(() => {
    if (at === undefined) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [at]);
  return now;
}

/** `Date.now()`, moved on every minute while mounted: the popover's ages and forecasts. */
export function useMinuteNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The window's one way into usage: the title bar's subscription meter, as a thin bar and a share,
 * opening onto every provider's 5-hour and weekly windows and a link to Settings → Usage. One rule
 * wherever it is (`shownLimit`): on a thread, that thread's agent's closest window, so its name
 * matches the composer's; elsewhere, or once another provider's is about to stop work, the highest
 * of all. Its hover and its popover's head name which ("This thread: …", "Highest: …"), and the
 * popover's foot says the rule. Neutral until 90%, so amber in the title bar means what needs you.
 * Until an agent reports a limit, an icon that opens the Usage page.
 *
 * Open, it gives way to the conversation: it drops where it covers no card that asks (under the
 * meter, else at the window's right edge, `clearRightEdge`), and closes when focus moves outside
 * it, onto an approval card's buttons say.
 */
export function UsageMeter({
  agent,
  className,
  textClassName,
  shortTextClassName = "hidden",
}: {
  /** The agent of the thread in view, whose usage the meter shows. */
  agent?: string | undefined;
  className?: string;
  /** For the reading beside the bar, which a narrow title bar trades for its short form. */
  textClassName?: string;
  /**
   * For the short reading ("85%"), shown where the full one is not: a narrow title bar keeps a
   * number beside the bar, never a bare bar. Hidden unless the caller shows it.
   */
  shortTextClassName?: string;
}) {
  const limits = useUsageLimits((s) => s.limits);
  const now = useLimitsNow(limits);
  const tightest = shownLimit(limits, now, agent);
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const anchor = useClearAnchor(trigger);
  useGiveWay(open, setOpen);
  if (tightest === undefined) return <UsageLink className={className} />;
  const warns = limitWarns(tightest.limit);
  const tone = limitTone(tightest.limit);
  const stale = limitStale(tightest.limit, now);

  return (
    <PulseOnce
      trigger={warns}
      when={warns}
      tone="warning"
      className={cn("rounded-full", className)}
    >
      <TitlebarPopover
        hint={meterHint(tightest)}
        label="Subscription usage"
        testId="usage-limits"
        // Wide enough that a provider's name, its reading's age and a date-and-time reset each keep
        // one line, in columns that line up down it.
        className={cn(POPOVER_WIDTH, "p-3")}
        anchor={anchor}
        keepClearBelow={ACTION_AREA_CLEARANCE}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button
            ref={setTrigger}
            type="button"
            data-testid="usage-meter"
            data-warn={warns || undefined}
            data-spent={tone === "spent" || undefined}
            data-stale={stale || undefined}
            aria-label={meterLabel(tightest)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-(--radius-sm) px-1.5 text-meta text-muted-foreground tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted",
              TONE_TEXT[tone],
            )}
          >
            {/* An old reading dims its bar only, so the words keep the text floor. */}
            <LimitBar limit={tightest.limit} className={cn("w-9", stale && "opacity-50")} />
            <span className={textClassName}>{meterText(tightest)}</span>
            {/* Drawn from its attribute, so the meter's words stay the one reading it has. */}
            <span
              aria-hidden
              data-testid="usage-meter-short"
              data-short={`${limitPercent(tightest.limit.utilization)}%`}
              className={cn("after:content-[attr(data-short)]", shortTextClassName)}
            />
          </button>
        }
      >
        <LimitsPopover shown={tightest} agent={agent} onLeave={() => setOpen(false)} />
      </TitlebarPopover>
    </PulseOnce>
  );
}

/**
 * Closes the open popover once focus moves outside it: a click or Tab onto an approval card's
 * buttons, the composer, anything in the conversation, which a ringed card's own focus does too.
 * Its trigger is no "outside": a click there toggles it as before. An ask arriving elsewhere leaves
 * it be: the user may be reading it.
 */
function useGiveWay(open: boolean, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const away = (event: FocusEvent) => {
      const target = event.target;
      // The window taking focus back (from a tab a middle-click opened, say) lands on the body:
      // nothing else asked for the user.
      if (!(target instanceof Element) || target === document.body) return;
      if (target.closest('[data-testid="usage-limits"], [data-testid="usage-meter"]')) return;
      setOpen(false);
    };
    document.addEventListener("focusin", away);
    return () => document.removeEventListener("focusin", away);
  }, [open, setOpen]);
}

/** The popover's width, in rem so it grows with the interface's text size. */
const POPOVER_REM = 23.75;
const POPOVER_WIDTH = "w-[23.75rem]";

/** The cards in view that ask for a decision: approvals and questions, wherever they are drawn. */
const DECISION_CARDS = "[data-request-id]";

/**
 * What the popover hangs from: the meter, or, while that would put it over a card that asks for a
 * decision, a point at the window's edge clear of every such card (`clearRightEdge`). Weighed each
 * time the popover is placed, so a card arriving while it is open moves it aside.
 */
function useClearAnchor(trigger: HTMLElement | null) {
  return useMemo(() => {
    if (trigger === null) return undefined;
    return {
      contextElement: trigger,
      getBoundingClientRect: () => {
        const own = trigger.getBoundingClientRect();
        const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const cards = [...document.querySelectorAll(DECISION_CARDS)]
          .map((card) => card.getBoundingClientRect())
          .filter((box) => box.width > 0 && box.height > 0);
        const right = clearRightEdge({
          trigger: own,
          cards,
          width: POPOVER_REM * rem,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
        return right === undefined
          ? own
          : DOMRect.fromRect({ x: right, y: own.top, width: 0, height: own.height });
      },
    };
  }, [trigger]);
}

/**
 * How much of the window's foot the popover leaves clear, in CSS px: the composer and an approval
 * or question card above it, the conversation's action area. A short window scrolls the popover
 * rather than laying it over them.
 */
const ACTION_AREA_CLEARANCE = 360;

/** Before any agent reports a limit: the Usage page, behind an icon with its name on hover. */
function UsageLink({ className }: { className?: string | undefined }) {
  return (
    <Hint
      label="Usage"
      side="bottom"
      render={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Usage"
          data-testid="usage-link"
          className={cn(
            "text-muted-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground",
            className,
          )}
          render={<Link to="/settings/usage" />}
          nativeButton={false}
        />
      }
    >
      <ChartNoAxesCombined aria-hidden />
    </Hint>
  );
}

/**
 * The popover's body, ticking each minute while open so ages and forecasts stay true: whose number
 * the title bar shows (`meterSource`), the columns' names once, then a block per provider, its name
 * and its reading's age on one row, a row per window saying its period, how much is used and when
 * it resets. The window the title bar shows is marked, the thread's agent named, and the foot says
 * the meter's rule, with the way on to the Usage page.
 */
function LimitsPopover({
  shown,
  agent,
  onLeave,
}: {
  shown: ShownLimit;
  /** The agent of the thread in view, whose block says so. */
  agent: string | undefined;
  /** Closes the popover as its link leaves for the Usage page. */
  onLeave: () => void;
}) {
  const now = useMinuteNow();
  return (
    <div className="grid gap-3 text-reading">
      <p data-testid="usage-limits-source" className="text-meta text-muted-foreground">
        In the title bar: <span className="text-foreground">{meterSource(shown)}</span>
      </p>
      <div
        aria-hidden
        data-testid="usage-limits-columns"
        className={cn(LIMIT_ROW, "-mb-1 text-meta text-muted-foreground")}
      >
        <span />
        <span className="col-span-2 text-right">Used</span>
        <span className="text-right">Resets</span>
      </div>
      {LIMIT_PROVIDERS.map((provider) => (
        <ProviderLimits
          key={provider}
          provider={provider}
          now={now}
          thisThread={agent === provider}
          shown={shown.provider === provider ? shown.window : undefined}
        />
      ))}
      <div className="grid gap-2 border-t border-border pt-2.5 text-meta text-muted-foreground">
        <p data-testid="usage-limits-foot">{METER_RULE} Includes your own use outside Gram.</p>
        <Link
          to="/settings/usage"
          data-testid="usage-limits-page"
          onClick={onLeave}
          className="justify-self-start rounded-(--radius-sm) text-body text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open Usage
        </Link>
      </div>
    </div>
  );
}

/**
 * The popover's columns, the same in every provider's block so they line up down it: the period,
 * its bar, the share used ("85%") and when it resets, both right-aligned under their names.
 */
const LIMIT_ROW = "grid grid-cols-[3.75rem_minmax(2rem,1fr)_2.75rem_6.75rem] items-center gap-x-2";

/**
 * A provider's 5-hour and weekly rows under its name and its reading's age, on one row in the
 * columns' grid so the age lines up under Resets; its credits when the agent reports them, and
 * under a row the forecast when there is pace enough to make one; nothing for a provider with no
 * current reading. An old reading says so in the same muted words as its age ("Old reading · 40m
 * ago"), never a mark that reads as a button, and never amber.
 */
function ProviderLimits({
  provider,
  now,
  thisThread,
  shown,
}: {
  provider: LimitProvider;
  now: number;
  /** The agent of the thread in view. */
  thisThread: boolean;
  /** The window the title bar's meter shows, when it is this provider's. */
  shown: LimitWindow | undefined;
}) {
  const windows = useUsageLimits((s) => s.limits[provider]);
  const current = LIMIT_WINDOWS.flatMap((window) => {
    const limit = currentLimit(windows?.[window], now);
    return limit === undefined ? [] : [limit];
  });
  if (current.length === 0) return null;
  const newest = current.reduce((a, b) => ((b.at ?? now) > (a.at ?? now) ? b : a));
  const stale = current.every((limit) => limitStale(limit, now));
  const credits = creditsText(newest);
  const age = agoText(newest.at ?? now, now);
  return (
    <section
      aria-label={agentLabel(provider)}
      data-provider={provider}
      className="grid gap-1.5 not-first-of-type:border-t not-first-of-type:border-border not-first-of-type:pt-3"
    >
      <div className={cn(LIMIT_ROW, "items-baseline")}>
        <div className="col-span-2 flex min-w-0 items-baseline gap-2">
          <h3 className="truncate font-medium whitespace-nowrap">{agentLabel(provider)}</h3>
          {thisThread && (
            <span
              data-testid="usage-limit-this-thread"
              className="shrink-0 text-meta whitespace-nowrap text-muted-foreground"
            >
              This thread
            </span>
          )}
        </div>
        <span
          data-testid="usage-limit-age"
          data-stale={stale || undefined}
          className="col-span-2 text-right text-meta whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {stale ? `Old reading · ${age}` : `Updated ${age}`}
        </span>
      </div>
      {credits !== undefined && (
        <p data-testid="usage-provider-credits" className="-mt-1 text-meta text-muted-foreground">
          {credits}
        </p>
      )}
      {LIMIT_WINDOWS.map((window) => {
        const limit = currentLimit(windows?.[window], now);
        const forecast =
          limit?.at === undefined || limit.samples === undefined
            ? undefined
            : limitForecast({ ...limit, at: limit.at, samples: limit.samples }, now);
        const reset = limit?.resetsAt === undefined ? undefined : resetAtText(limit.resetsAt, now);
        return (
          <Fragment key={window}>
            <div
              data-testid="usage-limit-row"
              data-window={window}
              data-shown={shown === window || undefined}
              aria-label={
                limit === undefined
                  ? `${WINDOW_LABEL[window]}: no reading`
                  : `${WINDOW_LABEL[window]}: ${limitPercent(limit.utilization)}% used${reset === undefined ? "" : `, resets ${reset}`}`
              }
              className={cn(
                LIMIT_ROW,
                "text-muted-foreground tabular-nums",
                shown === window && "text-foreground",
                limit !== undefined && TONE_TEXT[limitTone(limit)],
              )}
            >
              <span>{WINDOW_LABEL[window]}</span>
              {limit === undefined ? (
                <>
                  <span aria-hidden className="h-1 rounded-full bg-foreground/15" />
                  <span className="text-right">–</span>
                  <span />
                </>
              ) : (
                <>
                  <LimitBar limit={limit} />
                  <span data-testid="usage-limit-used" className="text-right whitespace-nowrap">
                    {limitPercent(limit.utilization)}%
                  </span>
                  <span data-testid="usage-limit-reset" className="text-right whitespace-nowrap">
                    {reset ?? ""}
                  </span>
                </>
              )}
            </div>
            {limit?.credits === true && (
              <p
                data-testid="usage-limit-credits"
                className="-mt-1 text-meta text-muted-foreground"
              >
                {CREDITS_TEXT}
              </p>
            )}
            {forecast !== undefined && (
              // A muted sub-row from the bar's column, marked as a trend, so the rows keep their
              // columns and it never reads as the reading's age.
              <p className={cn(LIMIT_ROW, "-mt-1 text-meta text-muted-foreground")}>
                <span aria-hidden />
                <span className="col-span-3 flex items-baseline gap-1">
                  <TrendingUp aria-hidden className="size-icon-chip shrink-0 self-center" />
                  <span data-testid="usage-limit-forecast">
                    {forecastText(forecast)}
                    {stale && " · from an older reading"}
                  </span>
                </span>
              </p>
            )}
          </Fragment>
        );
      })}
    </section>
  );
}

/** A reading's words by its tone (`limitTone`): neutral, then amber from 90%, red once spent. */
const TONE_TEXT = {
  neutral: undefined,
  warning: "text-warning hover:text-warning",
  spent: "text-destructive hover:text-destructive",
} as const;

const TONE_FILL = {
  neutral: "bg-muted-foreground",
  warning: "bg-warning",
  spent: "bg-destructive",
} as const;

/** A thin track whose fill glides to each new reading; amber from 90%, red once spent. */
export function LimitBar({ limit, className }: { limit: UsageLimit; className?: string }) {
  const percent = limitPercent(limit.utilization);
  return (
    <span
      aria-hidden
      className={cn("block h-1 shrink-0 overflow-hidden rounded-full bg-foreground/15", className)}
    >
      <span
        data-testid="usage-meter-fill"
        className={cn(
          "block h-full rounded-full transition-[width] duration-(--dur-move-base) ease-(--ease-spring)",
          TONE_FILL[limitTone(limit)],
        )}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

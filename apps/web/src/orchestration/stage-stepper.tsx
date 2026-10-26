import type { FeatureStage } from "@gram/contracts";
import { Check, Circle, CircleDot, Clock, Milestone } from "lucide-react";
import * as m from "motion/react-m";
import { useId, useRef, type ReactNode } from "react";

import { useNow } from "@/lib/use-now";
import { SidebarDetails } from "@/components/sidebar-details";
import { cn } from "@/lib/utils";
import { usePresetTransition } from "@/motion";

import { stageTitle, stepperModel, type StageStep, type StepStatus } from "./stage-model";

const STEP_ICON = { done: Check, current: CircleDot, upcoming: Circle } as const;

const STEP_WORD: Record<StepStatus, string> = {
  done: "done",
  current: "current",
  upcoming: "upcoming",
};

/** A step as a button once somebody can set it, and as plain text until then. */
function StepBody({
  step,
  onSelect,
  className,
  children,
}: {
  step: StageStep;
  onSelect: ((name: string) => void) | undefined;
  className: string;
  children: ReactNode;
}) {
  const label = `${step.name} (${STEP_WORD[step.status]})`;
  if (onSelect === undefined) {
    return (
      <span title={label} className={className}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={label}
      onClick={() => onSelect(step.name)}
      className={cn(
        className,
        "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </button>
  );
}

/**
 * Where a feature or a group stands in the team's own process: the plan
 * as steps with the current one emphasised, or one chip for a free label, then who said so and
 * when. The emphasis is one element shared between steps, so it glides to the new step when the
 * stage changes.
 *
 * `compact` draws the steps as pips with the current one named under them, for the board's narrow
 * feature column; otherwise every step carries its name and the row wraps. `bare` keeps only the
 * pips, for a line that names the stage in a chip beside them. Read-only until `onSelect` is given,
 * which is the seam for the user setting a stage by clicking a step.
 */
export function StageStepper({
  stage,
  subject,
  compact = false,
  bare = false,
  onSelect,
  className,
}: {
  stage: FeatureStage;
  /** What the stage is of, for the list's name: "mail-trigger". */
  subject: string;
  compact?: boolean;
  /** With `compact`: the pips alone, no name, attribution or note under them. */
  bare?: boolean;
  onSelect?: ((name: string) => void) | undefined;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = useNow(true, ref, 60_000);
  const glide = usePresetTransition("gentle");
  const highlight = `stage-current-${useId()}`;
  const model = stepperModel(stage, now);

  return (
    <div
      ref={ref}
      data-testid="stage-stepper"
      data-stage={model.current}
      data-stale={model.stale}
      className={cn("flex min-w-0 flex-col gap-1", className)}
    >
      {model.steps === undefined ? (
        <span
          data-testid="stage-label"
          title={model.current}
          className="inline-flex w-fit max-w-full items-center gap-1 rounded-sm border border-border px-1 text-[11px] text-foreground/80"
        >
          <Milestone aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{model.current}</span>
        </span>
      ) : compact ? (
        <>
          <ol aria-label={`Stages of ${subject}`} className="flex items-center gap-0.5">
            {model.steps.map((step) => (
              <li
                key={step.name}
                data-testid="stage-step"
                data-status={step.status}
                aria-current={step.status === "current" ? "step" : undefined}
                className={cn("min-w-0", step.status === "current" ? "flex-[2]" : "flex-1")}
              >
                <StepBody
                  step={step}
                  onSelect={onSelect}
                  className={cn(
                    // The pip is 6px tall; the padding around it is what a pointer can find.
                    "relative block w-full rounded-full py-1 after:block after:h-1.5 after:rounded-full",
                    step.status === "done" ? "after:bg-primary/45" : "after:bg-border-strong/60",
                  )}
                >
                  {step.status === "current" && (
                    <m.span
                      layoutId={highlight}
                      transition={glide}
                      aria-hidden
                      className="absolute inset-x-0 top-1 z-1 h-1.5 rounded-full bg-primary"
                    />
                  )}
                  <span className="sr-only">
                    {step.name} ({STEP_WORD[step.status]})
                  </span>
                </StepBody>
              </li>
            ))}
          </ol>
          {!bare && (
            <span className="flex min-w-0 items-baseline gap-1 text-[11px]">
              <span
                data-testid="stage-current"
                title={model.current}
                className="min-w-0 truncate font-medium text-foreground/90"
              >
                {model.current}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{model.position}</span>
            </span>
          )}
        </>
      ) : (
        <ol
          aria-label={`Stages of ${subject}`}
          className="flex flex-wrap items-center gap-x-0.5 gap-y-1 text-[11px]"
        >
          {model.steps.map((step, index) => {
            const Icon = STEP_ICON[step.status];
            return (
              <li
                key={step.name}
                data-testid="stage-step"
                data-status={step.status}
                aria-current={step.status === "current" ? "step" : undefined}
                className="flex min-w-0 items-center gap-0.5"
              >
                {index > 0 && (
                  <span aria-hidden className="h-px w-2 shrink-0 bg-border-strong/60" />
                )}
                <StepBody
                  step={step}
                  onSelect={onSelect}
                  className={cn(
                    "relative flex max-w-44 min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5",
                    step.status === "current"
                      ? "font-medium text-foreground"
                      : step.status === "done"
                        ? "text-foreground/70"
                        : "text-muted-foreground/80",
                  )}
                >
                  {step.status === "current" && (
                    <m.span
                      layoutId={highlight}
                      transition={glide}
                      aria-hidden
                      className="absolute inset-0 rounded-sm bg-primary/12 ring-1 ring-primary/40"
                    />
                  )}
                  <Icon
                    aria-hidden
                    className={cn(
                      "relative size-3 shrink-0",
                      step.status === "current" && "text-primary",
                    )}
                  />
                  <span className="relative truncate">{step.name}</span>
                  <span className="sr-only">({STEP_WORD[step.status]})</span>
                </StepBody>
              </li>
            );
          })}
        </ol>
      )}
      {!(compact && bare) && (
        <span
          data-testid="stage-attribution"
          title={
            model.stale
              ? "Set more than a day ago, so it may no longer be where things stand"
              : undefined
          }
          className={cn(
            "flex min-w-0 items-start gap-1 text-[11px]",
            model.stale ? "text-warning" : "text-muted-foreground",
          )}
        >
          {model.stale && <Clock aria-hidden className="mt-0.5 size-3 shrink-0" />}
          <span className="min-w-0 break-words">{model.attribution}</span>
          {model.stale && <span className="sr-only">, which may be out of date</span>}
        </span>
      )}
      {model.note !== undefined && !(compact && bare) && (
        <p
          data-testid="stage-note"
          title={model.note}
          className="line-clamp-2 text-[11px] break-words text-muted-foreground"
        >
          {model.note}
        </p>
      )}
    </div>
  );
}

/** The current stage as a muted chip, for a sidebar row or a table heading; the tooltip says the rest. */
export function StageChip({
  stage,
  brief = false,
  testId = "stage-chip",
  className,
}: {
  stage: FeatureStage;
  /** Sidebar disclosure: icon first; the workspace container reveals the label when it has room. */
  brief?: boolean;
  testId?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const model = stepperModel(stage, useNow(true, ref, 60_000));
  const content = (
    <span
      ref={ref}
      data-testid={testId}
      data-stale={model.stale}
      title={stageTitle(model)}
      className={cn(
        "inline-flex max-w-32 min-w-0 shrink items-center gap-1 rounded-sm border border-border px-1 text-[11px] font-normal text-muted-foreground",
        brief &&
          "shrink-0 border-transparent @min-[324px]/sidebar:max-w-24 @min-[324px]/sidebar:shrink @min-[324px]/sidebar:border-border",
        className,
      )}
    >
      {model.stale ? (
        <Clock aria-hidden className="size-2.5 shrink-0 text-warning" />
      ) : (
        <Milestone aria-hidden className="size-2.5 shrink-0" />
      )}
      {/* Keyed by the stage, so a new one fades in where the old one stood. */}
      <span
        key={model.current}
        className={cn(
          "gram-swap truncate",
          brief && "sr-only @min-[324px]/sidebar:not-sr-only @min-[324px]/sidebar:truncate",
        )}
      >
        {model.current}
      </span>
      {model.position !== undefined && !brief && (
        <span className="shrink-0 tabular-nums opacity-80">
          {model.position.replace(" of ", "/")}
        </span>
      )}
    </span>
  );
  return brief ? (
    <SidebarDetails label={stageTitle(model)} render={content} keyboard={false} />
  ) : (
    content
  );
}

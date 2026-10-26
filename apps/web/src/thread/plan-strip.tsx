import {
  planProgress,
  type PlanEdit,
  type PlanItem,
  type PlanSource,
  type PlanStep,
  type PlanStepStatus,
  type ThreadId,
  type ThreadSummary,
} from "@gram/contracts";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleDot,
  CircleSlash,
  Lock,
  Octagon,
  Pencil,
  Plus,
  RefreshCw,
  Sparkles,
  User,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { useApi } from "@/api/context";
import { PR_STATE_DISPLAY, prLifecycleOf } from "@/components/pr-marks-model";
import { agoText } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useNow } from "@/lib/use-now";
import { spin, Spinner, StatusMark, Swap, type MarkPhase } from "@/motion";
import { useThreadsStore } from "@/stores/threads";

import {
  cycleStatus,
  editOf,
  moveStep,
  stepPrBadge,
  stripLine,
  stripSteps,
  withStep,
} from "./plan-model";
import { PlanRing, useThreadHeadline } from "./plan-ui";

const STEP: Record<PlanStepStatus, { icon: LucideIcon; tone: string; label: string }> = {
  todo: { icon: Circle, tone: "text-muted-foreground", label: "To do" },
  doing: { icon: CircleDot, tone: "text-status-working", label: "In progress" },
  done: { icon: CircleCheck, tone: "text-success", label: "Done" },
  blocked: { icon: Octagon, tone: "text-destructive", label: "Blocked" },
  dropped: { icon: CircleSlash, tone: "text-muted-foreground", label: "Dropped" },
};

const SOURCE: Record<PlanSource, { icon: LucideIcon; label: string }> = {
  agent: { icon: Bot, label: "From the agent's own plan" },
  helper: { icon: Sparkles, label: "Kept by the helper" },
  user: { icon: User, label: "Edited by you" },
  orchestrator: { icon: Workflow, label: "From the orchestrator's brief" },
};

/** The plan statuses a `StatusMark` draws, so a step's ring fills and then checks in place. */
const STEP_MARK: Partial<Record<PlanStepStatus, MarkPhase>> = {
  todo: "todo",
  doing: "active",
  done: "done",
};

const TODO_ICON: Record<
  PlanItem["status"],
  { icon: LucideIcon; tone: string; mark?: MarkPhase | undefined }
> = {
  pending: { icon: Circle, tone: "text-muted-foreground", mark: "todo" },
  inProgress: { icon: Spinner, tone: "text-status-working", mark: "running" },
  completed: { icon: CircleCheck, tone: "text-success", mark: "done" },
  cancelled: { icon: CircleSlash, tone: "text-muted-foreground" },
};

const report = (op: Promise<unknown>) =>
  void op.catch((error: unknown) => console.error("plan", error));

/** Enter keeps the text, Escape leaves it; anything else types. */
function TextEdit({
  value,
  label,
  onDone,
  className,
}: {
  value: string;
  label: string;
  onDone: (text: string | undefined) => void;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onDone(text.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone(undefined);
    }
  };
  return (
    <input
      aria-label={label}
      autoFocus
      maxLength={80}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => onDone(text.trim())}
      className={cn(
        "min-w-0 flex-1 rounded-sm border border-border bg-background px-1.5 py-0.5 text-[13px] outline-none focus:border-primary",
        className,
      )}
    />
  );
}

function StepPr({
  step,
  git,
  boundPr,
}: {
  step: PlanStep;
  git: ThreadSummary["git"];
  boundPr: ThreadSummary["thread"]["boundPr"];
}) {
  if (step.pr === undefined) return null;
  const badge = stepPrBadge(step, git, boundPr);
  const state = badge === undefined ? undefined : prLifecycleOf(badge);
  // Quiet beside a step: GitHub's shape for its state, and its colour only once merged.
  const Icon = PR_STATE_DISPLAY[state ?? "open"].icon;

  return (
    <span
      data-testid="plan-step-pr"
      data-state={state}
      title={badge?.title}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
        state === "merged" ? "text-merged" : "text-muted-foreground",
      )}
    >
      <Icon aria-hidden className="size-3" />#{step.pr.number}
    </span>
  );
}

/** The agent's todo list for this turn, under the step it belongs to. */
function TurnTodos({ items }: { items: readonly PlanItem[] }) {
  return (
    <ul
      aria-label="The agent's todo list for this turn"
      className="mt-0.5 ml-5.5 flex flex-col gap-0.5 border-l border-border pl-2.5 text-xs text-muted-foreground"
    >
      {items.map((item, index) => {
        const display = TODO_ICON[item.status];
        return (
          <li key={`${index}-${item.content}`} className="flex items-center gap-1.5">
            <Swap swapKey={display.mark === undefined ? item.status : "mark"} className="shrink-0">
              {display.mark === undefined ? (
                <display.icon aria-hidden className={cn("size-3", display.tone)} />
              ) : (
                <StatusMark phase={display.mark} className={cn("size-3", display.tone)} />
              )}
            </Swap>
            <span className={cn(item.status === "completed" && "line-through")}>
              {item.status === "inProgress" ? (item.activeForm ?? item.content) : item.content}
            </span>
          </li>
        );
      })}
      <li className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
        <Bot aria-hidden className="size-2.5" /> the agent's todo list for this turn
      </li>
    </ul>
  );
}

function StepRow({
  step,
  editable,
  needsYou,
  git,
  boundPr,
  todos,
  first,
  last,
  onEdit,
}: {
  step: PlanStep;
  editable: boolean;
  needsYou: boolean;
  git: ThreadSummary["git"];
  boundPr: ThreadSummary["thread"]["boundPr"];
  todos: readonly PlanItem[] | undefined;
  first: boolean;
  last: boolean;
  onEdit: (f: (edit: PlanEdit) => PlanEdit) => void;
}) {
  const [editing, setEditing] = useState(false);
  const display = STEP[step.status];
  const source = SOURCE[step.source];
  const held = step.locked === true && (step.source === "user" || step.source === "orchestrator");
  return (
    <li data-testid="plan-step" data-status={step.status} className="group/step flex flex-col">
      <span className="flex items-start gap-2">
        <button
          type="button"
          disabled={!editable}
          aria-label={`${display.label}: ${step.text}${editable ? ". Change status" : ""}`}
          title={editable ? `${display.label} · click for the next status` : display.label}
          onClick={() =>
            onEdit((edit) =>
              withStep(edit, step.id, (s) => ({ ...s, status: cycleStatus(s.status) })),
            )
          }
          className="mt-0.5 shrink-0 rounded-full disabled:cursor-default"
        >
          <Swap swapKey={STEP_MARK[step.status] === undefined ? step.status : "mark"}>
            {STEP_MARK[step.status] === undefined ? (
              <display.icon aria-hidden className={cn("size-3.5", display.tone)} />
            ) : (
              <StatusMark
                phase={STEP_MARK[step.status]!}
                className={cn(
                  "size-3.5",
                  display.tone,
                  step.status === "doing" && needsYou && "text-status-needs",
                )}
              />
            )}
          </Swap>
        </button>
        {editing ? (
          <TextEdit
            value={step.text}
            label="Step"
            onDone={(text) => {
              setEditing(false);
              if (text === undefined || text === step.text) return;
              onEdit((edit) =>
                withStep(edit, step.id, (s) => (text === "" ? undefined : { ...s, text })),
              );
            }}
          />
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 text-[13px]",
              (step.status === "done" || step.status === "dropped") && "text-muted-foreground",
              step.status === "dropped" && "line-through",
            )}
          >
            {step.text}
            {step.evidence !== undefined && step.status === "done" && (
              <span className="text-muted-foreground/70"> · {step.evidence}</span>
            )}
          </span>
        )}
        <StepPr step={step} git={git} boundPr={boundPr} />
        {editable && !editing && (
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/step:opacity-100 group-hover/step:opacity-100">
            <button
              type="button"
              aria-label={`Edit “${step.text}”`}
              onClick={() => setEditing(true)}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <Pencil aria-hidden className="size-3" />
            </button>
            {!first && (
              <button
                type="button"
                aria-label={`Move “${step.text}” up`}
                onClick={() => onEdit((edit) => moveStep(edit, step.id, -1))}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <ArrowUp aria-hidden className="size-3" />
              </button>
            )}
            {!last && (
              <button
                type="button"
                aria-label={`Move “${step.text}” down`}
                onClick={() => onEdit((edit) => moveStep(edit, step.id, 1))}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
              >
                <ArrowDown aria-hidden className="size-3" />
              </button>
            )}
            <button
              type="button"
              aria-label={`Remove “${step.text}”`}
              onClick={() => onEdit((edit) => withStep(edit, step.id, () => undefined))}
              className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        )}
        {held && editable ? (
          <button
            type="button"
            title={`${source.label}; the helper leaves it alone. Click to let the helper update it.`}
            aria-label={`Let the helper update “${step.text}”`}
            onClick={() =>
              onEdit((edit) => withStep(edit, step.id, (s) => ({ ...s, locked: false })))
            }
            className="mt-0.5 flex shrink-0 items-center gap-0.5 text-muted-foreground/70 hover:text-foreground"
          >
            <source.icon aria-hidden className="size-3" />
            <Lock aria-hidden className="size-2.5" />
          </button>
        ) : (
          <span title={source.label} className="mt-0.5 shrink-0 text-muted-foreground/70">
            <source.icon aria-hidden className="size-3" />
            <span className="sr-only">{source.label}</span>
          </span>
        )}
      </span>
      {todos !== undefined && todos.length > 0 && <TurnTodos items={todos} />}
    </li>
  );
}

/** "Updated 2h ago from the transcript and PR state", by who wrote the plan last. */
const updatedText = (by: PlanSource, ago: string): string => {
  switch (by) {
    case "helper":
      return `Updated ${ago} from the transcript and PR state`;
    case "agent":
      return `Updated ${ago} by the agent`;
    case "user":
      return `Edited by you ${ago}`;
    case "orchestrator":
      return `Set ${ago} from the orchestrator's brief`;
  }
};

/**
 * Under the pane header: the thread's plan on one line, its ring, goal,
 * headline and count, folded until clicked; while the thread works, the headline names the step in
 * progress, not the command running. Opened, it lists the steps, each with its
 * status glyph (a click moves it on), its PR's live state, who wrote it, and on hover an edit,
 * moves and a remove; every edit makes the step the user's and locks it against the helper. The
 * agent's todo list for this turn sits under the step in progress, or stands for the steps while
 * the plan has none. Absent while the thread keeps no plan, and on an orchestrator, whose board is
 * its plan.
 */
export function PlanStrip({ threadId }: { threadId: ThreadId }) {
  const api = useApi();
  const summary = useThreadsStore((s) => s.byId[threadId]);
  const turnPlan = useThreadsStore((s) => s.plans[threadId]);
  const { headline, planned } = useThreadHeadline(threadId);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(open, undefined, 60_000);
  // Edits are whole plans, so each builds on the last one sent rather than on what the screen shows
  // until that one's `thread.plan` arrives: two quick clicks otherwise undo the first.
  const sent = useRef<PlanEdit | undefined>(undefined);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  if (summary === undefined || !planned || summary.thread.role !== undefined) return null;

  const plan = summary.plan;
  const { steps, fromTodo } = stripSteps(plan, turnPlan);
  const progress = planProgress({ steps });
  const needsYou = headline?.phase === "needsYou";
  const edit = (f: (edit: PlanEdit) => PlanEdit) => {
    const next = f(sent.current ?? editOf(plan));
    sent.current = next;
    saving.current = saving.current
      .then(() => api.setPlan(threadId, next))
      .catch((error: unknown) => console.error("plan", error))
      .finally(() => {
        if (sent.current === next) sent.current = undefined;
      });
  };
  const refresh = (rebuild: boolean) => {
    setRefreshing(true);
    report(api.refreshPlan(threadId, rebuild).finally(() => setRefreshing(false)));
  };
  const goal = plan?.goal ?? "";
  const doing = fromTodo ? undefined : steps.find((step) => step.status === "doing");
  const line = stripLine(headline, steps);

  return (
    <div
      data-testid="plan-strip"
      data-open={open}
      className="@container shrink-0 border-b border-border bg-card/30"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Plan: ${goal || "the agent's todo list"}, ${progress.done} of ${progress.total} done${line === undefined ? "" : `. ${line}`}`}
        onClick={() => setOpen(!open)}
        className="mx-auto flex h-8 w-full max-w-(--thread-max-width) items-center gap-2 px-6 text-xs text-muted-foreground hover:text-foreground @max-sm:px-3"
      >
        {/* While the thread works, the header's status is the one thing that moves, so the ring
            only counts. */}
        <PlanRing
          headline={{
            phase: headline === undefined || headline.phase === "working" ? "next" : headline.phase,
            done: progress.done,
            total: progress.total,
          }}
        />
        <span className="max-w-[50%] shrink-0 truncate font-medium text-foreground">
          {goal || "Plan"}
        </span>
        {line !== undefined && (
          <span
            data-testid="plan-strip-headline"
            className={cn("min-w-0 truncate @max-sm:hidden", needsYou && "text-status-needs")}
          >
            · {line}
          </span>
        )}
        {progress.total > 0 && (
          <span data-testid="plan-strip-count" className="ml-auto shrink-0 tabular-nums">
            {progress.done}/{progress.total}
          </span>
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-(--dur-fast)",
            progress.total === 0 && "ml-auto",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        // Capped to a share of the pane and scrolled, so eight steps and a todo list can't push the
        // composer out of a short grid pane.
        <div
          data-testid="plan-strip-body"
          className="mx-auto max-h-[calc(var(--pane-height,100vh)*0.4)] max-w-(--thread-max-width) overflow-y-auto px-6 pb-3 @max-sm:px-3"
        >
          {editingGoal ? (
            <div className="mb-1.5 flex">
              <TextEdit
                value={goal}
                label="Goal"
                onDone={(text) => {
                  setEditingGoal(false);
                  if (text !== undefined && text !== goal) edit((e) => ({ ...e, goal: text }));
                }}
              />
            </div>
          ) : null}
          <ol aria-label="Plan steps" className="flex flex-col gap-1">
            {steps.map((step, index) => (
              <StepRow
                key={step.id}
                step={step}
                editable={!fromTodo}
                needsYou={needsYou}
                git={summary.git}
                boundPr={summary.thread.boundPr}

                todos={doing?.id === step.id ? turnPlan : undefined}
                first={index === 0}
                last={index === steps.length - 1}
                onEdit={edit}
              />
            ))}
          </ol>
          {adding && (
            <div className="mt-1 flex items-center gap-2">
              <Circle aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <TextEdit
                value=""
                label="New step"
                onDone={(text) => {
                  setAdding(false);
                  if (text === undefined || text === "") return;
                  // A plan built on the agent's todo list starts from it as the user's own steps.
                  edit((e) => ({
                    ...e,
                    steps: [
                      ...(fromTodo
                        ? steps.map((s) => ({ text: s.text, status: s.status }))
                        : e.steps),
                      { text, status: "todo" },
                    ],
                  }));
                }}
              />
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1">
              {plan === undefined || fromTodo ? (
                <>
                  <Bot aria-hidden className="size-3" /> The agent's todo list
                </>
              ) : (
                <>
                  <Sparkles aria-hidden className="size-3" />
                  {updatedText(plan.updatedBy, agoText(plan.updatedAt, now))}
                </>
              )}
            </span>
            <span className="ml-auto flex items-center gap-3">
              <button
                type="button"
                onClick={() => setEditingGoal(true)}
                className="hover:text-foreground"
              >
                {goal === "" ? "Set a goal" : "Edit goal"}
              </button>
              {steps.length < 8 && (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-0.5 hover:text-foreground"
                >
                  <Plus aria-hidden className="size-3" /> Add step
                </button>
              )}
              <button
                type="button"
                disabled={refreshing}
                title="Bring the plan up to date from the transcript and PR state"
                onClick={() => refresh(false)}
                className="flex items-center gap-0.5 hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw aria-hidden ref={refreshing ? spin : undefined} className="size-3" />{" "}
                Refresh
              </button>
              <button
                type="button"
                disabled={refreshing}
                title="Drop the steps nobody locked and derive them again from the whole thread"
                onClick={() => refresh(true)}
                className="hover:text-foreground disabled:opacity-50"
              >
                Rebuild
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

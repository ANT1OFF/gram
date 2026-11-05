import { MessageSquare, Network, User, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { ChoiceCheck } from "@/components/choice-check";
import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { CHOICE_CARD } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion";
import type { NewEntry } from "@/orchestration/new-entry";
import { SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";

/**
 * Who picks up what the New form starts: a workspace's orchestrator, one worker straight away, or
 * the user with one agent in a one-off thread. Each is one of the New menu's old entries.
 */
export type Who = "orchestrator" | "worker" | "me";

export const WHO_ENTRY: Readonly<Record<Who, Exclude<NewEntry, "workspace">>> = {
  orchestrator: "task",
  worker: "worker",
  me: "oneOff",
};

/**
 * Each choice named plainly for the work it starts, with what comes of it in one sentence: a team,
 * whose orchestrator plans and briefs workers (`deliver`); a task, one worker of that orchestrator
 * in its own worktree through to a pull request (`startWorker`); and a chat, a one-off thread with
 * one agent and no workspace.
 */
export const WHO_CHOICES: readonly {
  readonly value: Who;
  readonly label: string;
  /** What a screen reader says for `label`, where its glyph would read badly. */
  readonly spoken?: string;
  readonly line: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
}[] = [
  {
    value: "worker",
    label: "Task",
    line: "One worker does it in its own worktree and opens a pull request.",
    icon: User,
    shortcut: "thread.newWorker",
  },
  {
    value: "orchestrator",
    label: "Team",
    line: "An orchestrator splits it up, runs workers and sees their pull requests merged.",
    icon: Network,
    shortcut: "thread.new",
  },
  {
    value: "me",
    label: "Chat",
    line: "You and one agent in a folder. No workspace or orchestrator.",
    icon: MessageSquare,
    shortcut: "thread.newInProject",
  },
];

function Choice({
  choice,
  checked,
  slab,
  disabled,
  onPick,
}: {
  choice: (typeof WHO_CHOICES)[number];
  checked: boolean;
  slab: string;
  disabled: boolean;
  onPick: (who: Who) => void;
}) {
  const hint = useShortcutHint(choice.shortcut);
  const Icon = choice.icon;
  return (
    <Hint
      label={withHint(choice.label, hint)}
      side="bottom"
      render={
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          aria-label={choice.spoken ?? choice.label}
          aria-description={choice.line}
          data-testid={`new-who-${choice.value}`}
          disabled={disabled}
          onClick={() => {
            if (!checked) onPick(choice.value);
          }}
          className={CHOICE_CARD}
        />
      }
    >
      {checked && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
      <span className="relative flex w-full items-center gap-1.5 text-reading font-medium">
        <Icon aria-hidden className="size-icon-row shrink-0" />
        {choice.label}
        <ChoiceCheck checked={checked} className="ml-auto" />
      </span>
      <span className="relative text-meta text-muted-foreground">{choice.line}</span>
    </Hint>
  );
}

/**
 * One stop on the New form's Where it runs row: what it is ("Workspace", "Repository",
 * "Checkout") in muted words, then its chip, a picker or a plain fact.
 */
export function WhereStop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-meta text-muted-foreground">{label}</span>
      {children}
    </span>
  );
}

/** A Where it runs stop that is a fact, not a choice: the same chip shape, with no menu. */
export function WhereFact({
  icon: Icon,
  children,
  testId,
}: {
  icon: LucideIcon;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-meta text-foreground"
    >
      <Icon aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Who does it and where it runs, folded to one line for a repeat start: the work type, then each
 * place in words ("Gram · gram · New worktree, new branch"), and Change, which unfolds the full
 * choice. The words are what the unfolded form would show, so nothing is decided out of sight.
 */
function NewFormSummary({
  who,
  places,
  onExpand,
  disabled,
}: {
  who: Who;
  places: readonly string[];
  onExpand: () => void;
  disabled: boolean;
}) {
  const choice = WHO_CHOICES.find((each) => each.value === who)!;
  const Icon = choice.icon;
  return (
    <div
      role="group"
      aria-label="Who does it and where it runs"
      data-testid="new-summary"
      className="flex min-w-0 items-center gap-2 rounded-md border border-edge bg-card py-1 pr-1 pl-2.5 text-meta"
    >
      <Icon aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-medium text-foreground">
        <span aria-hidden={choice.spoken === undefined ? undefined : true}>{choice.label}</span>
        {choice.spoken !== undefined && <span className="sr-only">{choice.spoken}</span>}
      </span>
      <span className="min-w-0 truncate text-muted-foreground" data-testid="new-summary-where">
        {places.map((place) => ` · ${place}`).join("")}
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="ml-auto shrink-0"
        data-testid="new-summary-change"
        aria-label="Change who does it or where it runs"
        aria-expanded={false}
        disabled={disabled}
        onClick={onExpand}
      >
        Change
      </Button>
    </div>
  );
}

/**
 * The top of the one New form, the same whoever does it, in the order a start is thought through:
 * the title, the goal (`goal`, the brief), where it runs (`where`: the workspace, the repository and
 * the checkout, or the folder, each named before submit), then Who does it, each choice with its
 * outcome in a line. `line`, when given, says one more thing about where it runs.
 *
 * With `summary`, a repeat start to the remembered place, where it runs and who does it fold to
 * one line naming the same choices, which Change unfolds; the brief stays first.
 */
export function NewFormHeader({
  who,
  onWho,
  goal,
  where,
  line,
  summary,
  disabled = false,
}: {
  who: Who;
  onWho: (who: Who) => void;
  /** The brief, first under the title. */
  goal?: ReactNode;
  where: ReactNode;
  line?: ReactNode;
  /** The places in words and how to unfold them; present only while the form is folded. */
  summary?: { readonly places: readonly string[]; readonly onExpand: () => void } | undefined;
  /** While a file is still uploading, which the other kind of draft couldn't take with it. */
  disabled?: boolean;
}) {
  const slab = useId();
  const labelId = useId();
  const whereId = useId();
  const title = (
    <header>
      <h1 className="font-heading text-title">New</h1>
    </header>
  );
  if (summary !== undefined) {
    return (
      <div className="flex flex-col gap-4">
        {title}
        {goal}
        <NewFormSummary
          who={who}
          places={summary.places}
          onExpand={summary.onExpand}
          disabled={disabled}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {title}
      {goal}
      <div
        role="group"
        aria-labelledby={whereId}
        data-testid="new-where"
        className="flex min-w-0 flex-col gap-2"
      >
        <span id={whereId} className="text-meta font-medium text-muted-foreground">
          Where it runs
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">{where}</div>
        {line !== undefined && (
          <p
            key={who}
            data-testid="task-way-note"
            className="gram-fade min-w-0 text-meta text-muted-foreground"
          >
            {line}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span id={labelId} className="text-meta font-medium text-muted-foreground">
          Who does it
        </span>
        <div
          role="radiogroup"
          aria-labelledby={labelId}
          className={cn(SEGMENT_TRACK, "grid grid-cols-1 sm:grid-cols-3")}
        >
          {WHO_CHOICES.map((choice) => (
            <Choice
              key={choice.value}
              choice={choice}
              checked={choice.value === who}
              slab={slab}
              disabled={disabled}
              onPick={onWho}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

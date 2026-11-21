import { useNewForm, useSoloWord } from "@/embed/store";
import { MessageSquare, Network, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { ChoiceCheck } from "@/components/choice-check";
import { Hint } from "@/components/hint";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { CHOICE_CARD } from "@/lib/selection";
import { usePhone } from "@/lib/use-phone";
import { cn } from "@/lib/utils";
import { SegmentSlab } from "@/motion";
import type { NewEntry } from "@/orchestration/new-entry";
import { SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";

/**
 * Who picks up what the New form starts: a workspace's orchestrator, which decides how to run it,
 * or the user with one agent in a one-off thread. Each is one of the New menu's entries.
 */
export type Who = "orchestrator" | "me";

export const WHO_ENTRY: Readonly<Record<Who, Exclude<NewEntry, "workspace">>> = {
  orchestrator: "task",
  me: "oneOff",
};

/**
 * Each choice named plainly for the work it starts, with what comes of it in one sentence: a team,
 * whose orchestrator plans it and runs workers when it needs them (`deliver`); and a chat, a
 * one-off thread with one agent and no workspace.
 */
export const WHO_CHOICES: readonly {
  readonly value: Who;
  readonly label: string;
  /** What a screen reader says for `label`, where its glyph would read badly. */
  readonly spoken?: string;
  readonly line: string;
  readonly icon: LucideIcon;
  /** Its glyph's colour, where the choice has one: the orchestrator's accent on Team. */
  readonly tone?: string;
  readonly shortcut: string;
}[] = [
  {
    value: "orchestrator",
    label: "Team",
    line: "An orchestrator plans it and runs workers as needed.",
    icon: Network,
    tone: "text-orchestrator",
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
        <Icon aria-hidden className={cn("size-icon-row shrink-0", choice.tone)} />
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
 * The top of the one New form, the same whoever does it, in the order a start is thought through:
 * the title, the goal (`goal`, the brief), where it runs (`where`: the workspace, the repository and
 * the checkout, or the folder, each named before submit), then Who does it, each choice with its
 * outcome in a line. `line`, when given, says one more thing about where it runs.
 *
 * `folded`, a repeat start to the remembered place, leaves out where it runs and who does it: the
 * line beside Start names both, and its Change unfolds them; the brief stays first.
 */
export function NewFormHeader({
  who,
  onWho,
  goal,
  where,
  line,
  folded = false,
  disabled = false,
}: {
  who: Who;
  onWho: (who: Who) => void;
  /** The brief, first under the title. */
  goal?: ReactNode;
  where: ReactNode;
  line?: ReactNode;
  /** A repeat start: where it runs and who does it stay out until the line beside Start unfolds them. */
  folded?: boolean | undefined;
  /** While a file is still uploading, which the other kind of draft couldn't take with it. */
  disabled?: boolean;
}) {
  const slab = useId();
  const labelId = useId();
  const soloWord = useSoloWord();
  const newForm = useNewForm();
  const choices = WHO_CHOICES.map((choice) => {
    if (choice.value === "me") {
      const label = newForm?.solo?.label ?? soloWord;
      if (label === undefined) return choice;
      return { ...choice, label, line: newForm?.solo?.line ?? "You and one agent in a folder." };
    }
    const words = choice.value === "orchestrator" ? newForm?.team : undefined;
    return words === undefined
      ? choice
      : { ...choice, label: words.label, line: words.line ?? choice.line };
  });
  const whereId = useId();
  const phone = usePhone();
  const title = phone ? null : (
    <header>
      <h1 className="font-heading text-title">New task</h1>
    </header>
  );
  if (folded) {
    return (
      <div className="flex flex-col gap-4">
        {title}
        {goal}
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
          className={cn(SEGMENT_TRACK, "grid grid-cols-1 sm:grid-cols-2")}
        >
          {choices.map((choice) => (
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

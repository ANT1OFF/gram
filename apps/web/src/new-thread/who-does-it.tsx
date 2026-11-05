import { MessageSquare, Network, User, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { ChoiceCheck } from "@/components/choice-check";
import { Hint } from "@/components/hint";
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
 * Each choice named for the work it suits, with who owns that work in one line: an agent team,
 * whose orchestrator plans and briefs workers (`deliver`); one worker of that orchestrator in its
 * own worktree, through to a pull request (`startWorker`); and a single agent chat, a one-off
 * thread with no workspace.
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
    value: "orchestrator",
    label: "Agent team (orchestrator)",
    line: "An orchestrator plans it and runs workers for you.",
    icon: Network,
    shortcut: "thread.new",
  },
  {
    value: "worker",
    label: "One worker → PR",
    spoken: "One worker to PR",
    line: "One agent works on it in its own worktree and opens a pull request.",
    icon: User,
    shortcut: "thread.newWorker",
  },
  {
    value: "me",
    label: "Single agent chat",
    line: "A single chat with one agent in a folder. No workspace or orchestrator.",
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
      <span className="relative flex w-full items-center gap-1.5 text-sm font-medium">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {choice.label}
        <ChoiceCheck checked={checked} className="ml-auto" />
      </span>
      <span className="relative text-xs text-muted-foreground">{choice.line}</span>
    </Hint>
  );
}

/**
 * The top of the one New form, the same whoever does it: the title, Who does it with each
 * choice's owner in a line, where it goes (`where`, an "in" chip), and one plain line on what
 * happens next there.
 */
export function NewFormHeader({
  who,
  onWho,
  where,
  line,
  disabled = false,
}: {
  who: Who;
  onWho: (who: Who) => void;
  where: ReactNode;
  line: ReactNode;
  /** While a file is still uploading, which the other kind of draft couldn't take with it. */
  disabled?: boolean;
}) {
  const slab = useId();
  const labelId = useId();
  return (
    <header className="flex flex-col gap-3">
      <h1 className="font-heading text-base font-medium">New</h1>
      <div className="flex flex-col gap-2">
        <span id={labelId} className="text-xs font-medium text-muted-foreground">
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
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          in
          {where}
        </span>
        <p key={who} data-testid="task-way-note" className="gram-fade min-w-0 basis-full">
          {line}
        </p>
      </div>
    </header>
  );
}

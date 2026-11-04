import { MessageSquare, Network, User, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
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
 * Each choice with who owns the work in one line, so the name alone needn't say whether an agent
 * runs: the orchestrator plans and briefs workers (`deliver`), a direct worker is one agent held
 * as the user's in its own worktree (`startWorker`), and Just me is a one-off thread with no
 * workspace.
 */
export const WHO_CHOICES: readonly {
  readonly value: Who;
  readonly label: string;
  readonly line: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
}[] = [
  {
    value: "orchestrator",
    label: "Orchestrator",
    line: "An orchestrator plans it and runs workers for you.",
    icon: Network,
    shortcut: "thread.new",
  },
  {
    value: "worker",
    label: "Worker",
    line: "One agent works on it in its own worktree and opens a pull request.",
    icon: User,
    shortcut: "thread.newWorker",
  },
  {
    value: "me",
    label: "Just me",
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
          aria-label={choice.label}
          aria-description={choice.line}
          data-testid={`new-who-${choice.value}`}
          disabled={disabled}
          onClick={() => {
            if (!checked) onPick(choice.value);
          }}
          className="relative flex flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:text-foreground"
        />
      }
    >
      {checked && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
      <span className="relative flex items-center gap-1.5 text-sm font-medium">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        {choice.label}
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

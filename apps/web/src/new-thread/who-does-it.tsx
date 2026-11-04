import { MessageSquare, Network, User, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { SegmentSlab } from "@/motion";
import type { NewEntry } from "@/orchestration/new-entry";
import { SEGMENT, SEGMENT_SLAB, SEGMENT_TRACK } from "@/settings/fields";

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

const CHOICES: readonly {
  readonly value: Who;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
}[] = [
  { value: "orchestrator", label: "Orchestrator", icon: Network, shortcut: "thread.new" },
  { value: "worker", label: "Worker", icon: User, shortcut: "thread.newWorker" },
  { value: "me", label: "Just me", icon: MessageSquare, shortcut: "thread.newInProject" },
];

function Choice({
  choice,
  checked,
  slab,
  disabled,
  onPick,
}: {
  choice: (typeof CHOICES)[number];
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
        <Button
          type="button"
          size="sm"
          role="radio"
          aria-checked={checked}
          variant="ghost"
          data-testid={`new-who-${choice.value}`}
          className={SEGMENT}
          disabled={disabled}
          onClick={() => {
            if (!checked) onPick(choice.value);
          }}
        />
      }
    >
      {checked && <SegmentSlab group={slab} className={SEGMENT_SLAB} />}
      <Icon aria-hidden data-icon="inline-start" className="relative" />
      <span className="relative">{choice.label}</span>
    </Hint>
  );
}

/**
 * The top of the one New form, the same whoever does it: the title, Who does it, where it goes
 * (`where`, an "in" chip), and one plain line on what happens next.
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span id={labelId} className="text-xs font-medium text-muted-foreground">
            Who does it
          </span>
          <div role="radiogroup" aria-labelledby={labelId} className={SEGMENT_TRACK}>
            {CHOICES.map((choice) => (
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
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          in
          {where}
        </div>
      </div>
      <p key={who} data-testid="task-way-note" className="gram-fade text-xs text-muted-foreground">
        {line}
      </p>
    </header>
  );
}

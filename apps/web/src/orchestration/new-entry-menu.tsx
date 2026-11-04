import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useShortcutHint, withHint } from "@/keyboard/use-shortcut-hint";
import { focusedThreadId } from "@/shell/thread-switcher";

import { newEntryRoute, prefillOneOff, type NewEntry } from "./new-entry";
import { useTaskDraftStore } from "./task-draft-store";

/** What `+` opens: the New form on the choice used last, the orchestrator's task at first. */
export const newEntryOf = (remembered: NewEntry | undefined): Exclude<NewEntry, "workspace"> =>
  remembered === undefined || remembered === "workspace" ? "task" : remembered;

const SHORTCUT: Readonly<Record<Exclude<NewEntry, "workspace">, string>> = {
  task: "thread.new",
  worker: "thread.newWorker",
  oneOff: "thread.newInProject",
};

/**
 * The overview header's `+`: the one New form, on Who does it as it was last left (the
 * agent team, one worker or a single agent chat). Where it goes, a new workspace included, is the form's own
 * "in" chip.
 */
export function NewEntryMenu() {
  const navigate = useNavigate();
  const entry = newEntryOf(useTaskDraftStore((s) => s.entry));
  const hint = useShortcutHint(SHORTCUT[entry]);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="New"
      data-testid="new-entry"
      data-entry={entry}
      title={withHint("New task, worker or thread", hint)}
      className="ml-auto text-muted-foreground [-webkit-app-region:no-drag]"
      onClick={() => {
        if (entry === "oneOff") prefillOneOff(focusedThreadId());
        void navigate(newEntryRoute(entry));
      }}
    >
      <Plus />
    </Button>
  );
}

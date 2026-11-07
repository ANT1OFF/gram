import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { WHO_CHOICES } from "@/new-thread/who-does-it";
import { focusedThreadId } from "@/shell/thread-switcher";

import { newEntryRoute, prefillOneOff, type NewEntry } from "./new-entry";
import { useTaskDraftStore } from "./task-draft-store";

/** What the New form opens on by itself: the choice used last, the orchestrator's task at first. */
export const newEntryOf = (remembered: NewEntry | undefined): Exclude<NewEntry, "workspace"> =>
  remembered === undefined || remembered === "workspace" ? "task" : remembered;

/** The New form each of Who does it's choices opens on. */
const ENTRY_OF: Readonly<Record<(typeof WHO_CHOICES)[number]["value"], NewEntry>> = {
  worker: "worker",
  orchestrator: "task",
  me: "oneOff",
};

/**
 * The overview header's `+`, an icon as every title-bar control is: a menu of what New starts, Task,
 * Team and Chat, each with its shortcut, in Who does it's words and order. A pick opens the one New
 * form on that choice; where it runs, a new workspace included, is the form's own row.
 */
export function NewEntryMenu() {
  const navigate = useNavigate();
  const last = newEntryOf(useTaskDraftStore((s) => s.entry));
  const open = (entry: NewEntry) => {
    if (entry === "oneOff") prefillOneOff(focusedThreadId());
    void navigate(newEntryRoute(entry));
  };
  return (
    <Menu.Root>
      <Hint
        label="New task, team or chat"
        side="bottom"
        render={
          <Menu.Trigger
            render={<Button variant="ghost" size="icon-sm" aria-label="New" />}
            data-testid="new-entry"
            data-entry={last}
            className="ml-auto text-muted-foreground [-webkit-app-region:no-drag]"
          />
        }
      >
        <Plus />
      </Hint>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="isolate z-50 outline-none">
          <Menu.Popup data-testid="new-entry-menu" aria-label="New" className={MENU_POPUP}>
            <div className={MENU_LABEL}>New</div>
            {WHO_CHOICES.map((choice) => (
              <NewChoice
                key={choice.value}
                choice={choice}
                onPick={() => open(ENTRY_OF[choice.value])}
              />
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** One of New's choices: its glyph, its word and what it starts, and its shortcut at the end. */
function NewChoice({
  choice,
  onPick,
}: {
  choice: (typeof WHO_CHOICES)[number];
  onPick: () => void;
}) {
  const hint = useShortcutHint(choice.shortcut);
  const Icon = choice.icon;
  return (
    <Menu.Item
      data-testid="new-entry-choice"
      data-who={choice.value}
      title={choice.line}
      onClick={onPick}
      className={cn(MENU_ITEM, "w-60 max-w-[calc(100vw-2rem)]")}
    >
      <Icon aria-hidden className="text-muted-foreground" />
      <span className="flex-1">{choice.label}</span>
      {hint !== "" && (
        <kbd className="shrink-0 pl-3 font-sans text-caption text-muted-foreground tabular-nums">
          {hint}
        </kbd>
      )}
    </Menu.Item>
  );
}

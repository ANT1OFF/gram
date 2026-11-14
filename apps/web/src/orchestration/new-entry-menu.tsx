import { Menu } from "@base-ui/react/menu";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";

import { Hint } from "@/components/hint";
import { Button } from "@/components/ui/button";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { MENU_ITEM, MENU_LABEL, MENU_POPUP } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { useEmbedShell } from "@/embed/store";
import { WHO_CHOICES } from "@/new-thread/who-does-it";
import { focusedThreadId } from "@/shell/thread-switcher";

import { newEntryRoute, prefillOneOff, type NewEntry } from "./new-entry";
import { useTaskDraftStore } from "./task-draft-store";

/** New as the overview head's icon (words beside it where the head has room). */
const NEW_ICON =
  "ml-auto gap-1 text-muted-foreground [-webkit-app-region:no-drag] @min-[12.5rem]/overview-head:w-auto @min-[12.5rem]/overview-head:pr-2.5 @min-[12.5rem]/overview-head:pl-1.5 in-data-phone-drawer:ml-0 in-data-phone-drawer:size-11 in-data-phone-drawer:bg-primary in-data-phone-drawer:text-primary-foreground!";

/** New as a phone menu's pill. */
const PILL =
  "inline-flex h-13 shrink-0 items-center gap-2.5 rounded-full bg-foreground pr-6 pl-5 text-reading font-medium text-background shadow-overlay outline-none transition-[scale,opacity] duration-(--dur-fast) ease-(--ease-out) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-safe:active:scale-[0.97] [&_svg]:size-5";

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
 * The overview header's `+` and, where the header has room for them beside its icons, the words
 * "New task", so the way to start work is read rather than recognised: a menu of what New starts,
 * Task, Team and Chat, each with its shortcut, in Who does it's words and order. A pick opens the
 * one New form on that choice; where it runs, a new workspace included, is the form's own row.
 */
export function NewEntryMenu({
  pill = false,
}: {
  /** A phone menu's foot: a large rounded "New" in the foreground's colour, its menu above it. */
  pill?: boolean;
} = {}) {
  const navigate = useNavigate();
  const last = newEntryOf(useTaskDraftStore((s) => s.entry));
  // An app in front of Gram may have New start something of its own: one plain button, no menu.
  const hosts = useEmbedShell((s) => s.newEntry);
  const open = (entry: NewEntry) => {
    if (entry === "oneOff") prefillOneOff(focusedThreadId());
    void navigate(newEntryRoute(entry));
  };
  if (hosts !== undefined) {
    const shared = {
      "aria-label": hosts.label,
      "data-testid": "new-entry",
      "data-entry": "host",
      className: pill ? PILL : NEW_ICON,
      onClick: () => void navigate({ to: hosts.to as "/" }),
    };
    return (
      <Hint
        label={hosts.label}
        side="bottom"
        render={
          pill ? (
            <button type="button" {...shared} />
          ) : (
            <Button variant="ghost" size="icon-sm" {...shared} />
          )
        }
      >
        <Plus />
        <span
          data-testid="new-entry-words"
          className={pill ? undefined : "hidden text-body @min-[12.5rem]/overview-head:inline"}
        >
          {hosts.label}
        </span>
      </Hint>
    );
  }
  return (
    <Menu.Root>
      <Hint
        label="New task, team or chat"
        side="bottom"
        render={
          <Menu.Trigger
            render={
              pill ? (
                <button type="button" aria-label="New" />
              ) : (
                <Button variant="ghost" size="icon-sm" aria-label="New task" />
              )
            }
            data-testid="new-entry"
            data-entry={last}
            className={pill ? PILL : NEW_ICON}
          />
        }
      >
        <Plus />
        {pill ? (
          <span data-testid="new-entry-words">New</span>
        ) : (
          <span
            data-testid="new-entry-words"
            className="hidden text-body @min-[12.5rem]/overview-head:inline"
          >
            New task
          </span>
        )}
      </Hint>
      <Menu.Portal>
        <Menu.Positioner
          align="end"
          side={pill ? "top" : "bottom"}
          sideOffset={pill ? 8 : 4}
          className="isolate z-50 outline-none"
        >
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

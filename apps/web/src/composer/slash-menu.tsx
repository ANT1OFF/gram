import { Cable, CircleSlash } from "lucide-react";
import { Fragment, useEffect } from "react";

import { cn } from "@/lib/utils";
import { ListHighlight } from "@/motion";

import type { MenuCommand } from "./slash-native";

export const POPOVER =
  "absolute right-0 bottom-full left-0 z-20 mb-1 rounded-lg border border-border bg-popover p-1 text-sm shadow-md";

export function SlashMenu({
  id,
  commands,
  activeIndex,
  onChoose,
}: {
  id: string;
  commands: readonly MenuCommand[];
  activeIndex: number;
  onChoose: (command: MenuCommand) => void;
}) {
  // Focus stays in the textarea, so the browser won't scroll the active option into view itself.
  useEffect(() => {
    document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [id, activeIndex]);

  // Gram's rows sit under a heading when they end the list, as they do until a typed name
  // matches one of them better than the agent's; otherwise each carries the mark.
  const firstNative = commands.findIndex((c) => c.action !== undefined);
  const headed =
    firstNative !== -1 && commands.slice(firstNative).every((c) => c.action !== undefined);

  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Slash commands"
      className={cn(POPOVER, "gram-pop isolate max-h-64 overflow-y-auto")}
    >
      <ListHighlight
        targetId={`${id}-${activeIndex}`}
        layout={commands.map((c) => c.name).join("\n")}
        className="rounded-md bg-accent ring-1 ring-ring ring-inset"
      />
      {commands.map((command, index) => (
        <Fragment key={command.name}>
          {headed && index === firstNative && (
            <li
              role="presentation"
              className={cn(
                "flex items-center gap-1 px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground",
                index > 0 && "mt-1 border-t border-border pt-1.5",
              )}
            >
              <Cable aria-hidden className="size-3" />
              Gram
            </li>
          )}
          <li
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            // A screen reader doesn't get the group from the heading above.
            aria-description={command.action === undefined ? undefined : "Gram does this"}
            // Keep focus in the textarea.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(command)}
            className={cn(
              "flex cursor-default items-baseline gap-2 rounded-md px-2 py-1",
              index === activeIndex && "text-accent-foreground",
            )}
          >
            <span className="font-mono">/{command.name}</span>
            {command.argumentHint && (
              <span className="font-mono text-xs text-muted-foreground">
                {command.argumentHint}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {command.description}
            </span>
            {!headed && command.action !== undefined && (
              <span title="Gram does this" className="shrink-0 self-center">
                <Cable aria-hidden className="size-3 text-muted-foreground" />
              </span>
            )}
          </li>
        </Fragment>
      ))}
    </ul>
  );
}

/** Says, before anything is sent, that the command typed does nothing in a thread. */
export function SlashNote({ note }: { note: string }) {
  return (
    <div
      role="status"
      data-testid="slash-note"
      className={cn(POPOVER, "flex items-start gap-2 px-2 py-1.5 text-xs text-muted-foreground")}
    >
      <CircleSlash aria-hidden className="mt-px size-3.5 shrink-0 text-warning" />
      <span>{note}</span>
    </div>
  );
}

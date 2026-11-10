import type { FolderEntry, HostId } from "@gram/contracts";
import { Folder, FolderGit2 } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";
import { usePresetTransition } from "@/motion";

import { GitBadge } from "./git-badge";
import { splitForCompletion, tabCompletion } from "./path";
import { useCompletions } from "./use-folder";

interface PathFieldProps {
  value: string;
  onChange: (value: string) => void;
  debounceMs?: number;
  /** A joined machine whose folders are suggested, through its host; this Mac's when absent. */
  hostId?: HostId | undefined;
  /** The field's name; "Project path" when absent. */
  label?: string;
  placeholder?: string;
}

/**
 * The project path input: folder suggestions as you type, Tab to complete the common prefix,
 * ↑↓ and ⏎ to pick a suggestion, Esc to dismiss. `~` is expanded by the server.
 */
export function PathField({
  value,
  onChange,
  debounceMs,
  hostId,
  label = "Project path",
  placeholder = "~/Documents/code/my-repo",
}: PathFieldProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = useCompletions(value, open, debounceMs, hostId);
  const showList = open && matches.length > 0;
  const transition = usePresetTransition("snappy");
  const { dir, leaf } = splitForCompletion(value);

  const change = (next: string) => {
    onChange(next);
    setActive(-1);
    setOpen(true);
  };
  const accept = (entry: FolderEntry) => change(`${dir}${entry.name}/`);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        if (matches.length === 0) return;
        event.preventDefault();
        setOpen(true);
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + step + matches.length) % matches.length);
        return;
      }
      case "Enter": {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        const entry = showList ? matches[active] : undefined;
        if (entry) accept(entry);
        else setOpen(false);
        return;
      }
      case "Tab": {
        if (event.shiftKey || !showList) return;
        const completed = tabCompletion(value, matches);
        if (completed === undefined) return;
        event.preventDefault();
        change(completed);
        return;
      }
      case "Escape":
        if (!showList) return;
        event.preventDefault();
        setOpen(false);
    }
  };

  return (
    <div className="relative min-w-0 flex-1">
      <input
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 font-mono text-meta outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        value={value}
        onChange={(event) => change(event.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      <AnimatePresence>
        {showList && (
          <m.ul
            id={listId}
            role="listbox"
            aria-label="Folder suggestions"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={transition}
            className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-edge bg-popover p-1 shadow-overlay"
          >
            {matches.map((entry, i) => (
              <li
                key={entry.path}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(entry);
                }}
                onMouseEnter={() => setActive(i)}
                className="flex h-7 cursor-default items-center gap-2 rounded-md px-2 aria-selected:bg-accent"
              >
                {entry.isGitRepo ? (
                  <FolderGit2
                    aria-hidden
                    className="size-icon-row shrink-0 text-muted-foreground"
                  />
                ) : (
                  <Folder aria-hidden className="size-icon-row shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-meta">
                  <span className="text-foreground">{entry.name.slice(0, leaf.length)}</span>
                  <span className={cn(leaf ? "text-muted-foreground" : "text-foreground")}>
                    {entry.name.slice(leaf.length)}
                  </span>
                </span>
                {entry.isGitRepo && <GitBadge />}
              </li>
            ))}
          </m.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

import type { FsFileName } from "@gram/contracts";
import { File, Folder } from "lucide-react";
import { useEffect } from "react";

import { cn } from "@/lib/utils";
import { ListHighlight } from "@/motion";

import { mentionPath } from "./mention";

export function MentionMenu({
  id,
  entries,
  activeIndex,
  onChoose,
}: {
  id: string;
  entries: readonly FsFileName[];
  activeIndex: number;
  onChoose: (entry: FsFileName) => void;
}) {
  useEffect(() => {
    document.getElementById(`${id}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [id, activeIndex]);

  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Files"
      className="gram-pop absolute right-0 bottom-full left-0 isolate z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm shadow-md"
    >
      <ListHighlight
        targetId={`${id}-${activeIndex}`}
        layout={entries.map(mentionPath).join("\n")}
        className="rounded-md bg-accent ring-1 ring-ring ring-inset"
      />
      {entries.map((entry, index) => {
        const path = mentionPath(entry);
        const name = path.lastIndexOf("/", path.length - 2) + 1;
        const Icon = entry.kind === "dir" ? Folder : File;
        return (
          <li
            key={path}
            id={`${id}-${index}`}
            role="option"
            aria-label={path}
            aria-selected={index === activeIndex}
            // Keep focus in the textarea.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(entry)}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1",
              index === activeIndex && "text-accent-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs">
              <span className="text-muted-foreground">{path.slice(0, name)}</span>
              {path.slice(name)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

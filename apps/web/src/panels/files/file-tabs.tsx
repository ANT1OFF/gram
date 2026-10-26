import { X } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

import { fileIcon } from "./file-icon";

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1) || path;

/**
 * The open files as tabs above the preview: a click shows one, its × or a middle-click closes it.
 * One Tab stop; ← → move between tabs and Delete closes the focused one.
 */
export function FileTabs({
  open,
  selected,
  root,
  onSelect,
  onClose,
}: {
  open: readonly string[];
  selected: string | undefined;
  root: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusTab = (index: number) =>
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number, path: string) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next = (index + (event.key === "ArrowRight" ? 1 : -1) + open.length) % open.length;
      onSelect(open[next]!);
      focusTab(next);
    } else if (event.key === "Delete") {
      event.preventDefault();
      onClose(path);
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Open files"
      className="flex shrink-0 overflow-x-auto border-b border-border [scrollbar-width:none]"
    >
      {open.map((path, index) => {
        const name = baseName(path);
        const active = path === selected;
        const { icon: Icon, tone } = fileIcon(name, "file");
        return (
          <div
            key={path}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path}
            onClick={() => onSelect(path)}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(path);
            }}
            onKeyDown={(event) => onKeyDown(event, index, path)}
            className={cn(
              "group/tab flex h-8 max-w-48 shrink-0 cursor-default items-center gap-1.5 border-e border-border ps-2.5 pe-1 text-xs text-muted-foreground outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon aria-hidden className={cn("size-3.5 shrink-0", tone)} />
            <span className="min-w-0 truncate">{name}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(path);
              }}
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                !active && "opacity-0 group-hover/tab:opacity-100",
              )}
            >
              <X aria-hidden className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

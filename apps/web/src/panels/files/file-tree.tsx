import type { FsEntry, ThreadId } from "@gram/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { useApi } from "@/api/context";
import { errorMessage } from "@/api/errors";
import { folderAccessDenial } from "@/api/folder-access";
import { FolderAccessRecovery } from "@/components/folder-access-recovery";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/motion";

import { fileIcon } from "./file-icon";
import { useFilesStore } from "./files-store";
import { filesProblem } from "./files-problem";

export const filesQueryKey = (threadId: string, path: string, showHidden: boolean) =>
  ["fs.list", threadId, path, showHidden] as const;

const sortEntries = (entries: readonly FsEntry[]) =>
  entries.toSorted(
    (a, b) =>
      Number(b.kind === "dir") - Number(a.kind === "dir") ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );

const indent = (depth: number) => ({ paddingInlineStart: `${(depth - 1) * 12 + 6}px` });

/** The tree's one Tab stop: the item last focused. */
const ActiveItem = createContext<{
  readonly active: string | undefined;
  readonly setActive: (path: string) => void;
}>({ active: undefined, setActive: () => {} });

/**
 * Moves focus between the visible items, in DOM order: ↑ / ↓, Home / End, → into an open folder's
 * first child, ← up to the parent. A row's own → / ← (open, close a folder) runs first.
 */
export function treeKeyDown(event: KeyboardEvent<HTMLUListElement>) {
  if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
  const current = document.activeElement;
  if (!(current instanceof HTMLElement) || current.getAttribute("role") !== "treeitem") return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const index = items.indexOf(current);
  let next: HTMLElement | null | undefined;
  switch (event.key) {
    case "ArrowDown":
      next = items[Math.min(index + 1, items.length - 1)];
      break;
    case "ArrowUp":
      next = items[Math.max(index - 1, 0)];
      break;
    case "Home":
      next = items[0];
      break;
    case "End":
      next = items.at(-1);
      break;
    case "ArrowRight":
      if (current.getAttribute("aria-expanded") === "true") {
        next = current.querySelector<HTMLElement>('[role="treeitem"]');
      }
      break;
    case "ArrowLeft":
      if (current.getAttribute("aria-expanded") !== "true") {
        next = current.parentElement?.closest<HTMLElement>('[role="treeitem"]');
      }
      break;
    default:
      return;
  }
  event.preventDefault();
  next?.focus();
}

/**
 * The checkout as a lazily expanded tree: folders load when opened. One Tab stop; ↑ ↓ Home End
 * move, → / ← open and close a folder or step into and out of it, ⏎ opens a folder or previews a
 * file.
 */
export function FileTree({ threadId, root }: { threadId: ThreadId; root: string }) {
  const [active, setActive] = useState<string>();
  const treeRef = useRef<HTMLUListElement>(null);

  // The active item may be gone (collapsed, filtered out): the first item takes the Tab stop.
  // Runs after every render because folders load lazily; it only sets state when that changes.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree || tree.querySelector('[role="treeitem"][tabindex="0"]')) return;
    const first = tree.querySelector<HTMLElement>('[role="treeitem"]')?.dataset["path"];
    if (first !== undefined && first !== active) setActive(first);
  });

  return (
    <ActiveItem.Provider value={{ active, setActive }}>
      <ul
        ref={treeRef}
        role="tree"
        aria-label="Files"
        className="p-1 text-sm"
        onKeyDown={treeKeyDown}
      >
        <TreeLevel threadId={threadId} path={root} depth={1} />
      </ul>
    </ActiveItem.Provider>
  );
}

function TreeLevel({ threadId, path, depth }: { threadId: ThreadId; path: string; depth: number }) {
  const api = useApi();
  const showHidden = useFilesStore((s) => s.showHidden);
  const filter = useFilesStore((s) => s.filter.trim().toLowerCase());
  const query = useQuery({
    queryKey: filesQueryKey(threadId, path, showHidden),
    queryFn: () => api.fsList(path, { threadId, showHidden }),
    retry: false,
  });

  if (query.status === "pending") {
    return (
      <li role="none" className="py-1 text-xs text-muted-foreground" style={indent(depth + 1)}>
        <Shimmer>Loading…</Shimmer>
      </li>
    );
  }
  const denial = query.status === "error" ? folderAccessDenial(query.error) : undefined;
  if (denial) {
    return (
      <li role="none" style={indent(depth + 1)}>
        <FolderAccessRecovery
          denial={denial}
          message={errorMessage(query.error)}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      </li>
    );
  }
  if (query.status === "error") {
    return (
      <li role="none" className="py-1 text-xs text-danger-text" style={indent(depth + 1)}>
        {filesProblem(query.error)}
      </li>
    );
  }
  const entries = sortEntries(query.data.entries).filter(
    (entry) => entry.kind === "dir" || !filter || entry.name.toLowerCase().includes(filter),
  );
  return (
    <>
      {entries.map((entry) => (
        <TreeRow key={entry.path} threadId={threadId} entry={entry} depth={depth} />
      ))}
      {entries.length === 0 && (
        <li role="none" className="py-1 text-xs text-muted-foreground" style={indent(depth + 1)}>
          {filter ? "No matching files" : "Empty folder"}
        </li>
      )}
      {query.data.truncated && (
        <li role="none" className="py-1 text-xs text-muted-foreground" style={indent(depth + 1)}>
          More files not shown
        </li>
      )}
    </>
  );
}

function TreeRow({
  threadId,
  entry,
  depth,
}: {
  threadId: ThreadId;
  entry: FsEntry;
  depth: number;
}) {
  const isDir = entry.kind === "dir";
  const expanded = useFilesStore(
    (s) => s.byThread[threadId]?.expanded.includes(entry.path) ?? false,
  );
  const selected = useFilesStore((s) => s.byThread[threadId]?.selected === entry.path);
  const toggle = useFilesStore((s) => s.toggle);
  const select = useFilesStore((s) => s.select);
  const activate = () => (isDir ? toggle(threadId, entry.path) : select(threadId, entry.path));
  const { active, setActive } = useContext(ActiveItem);
  const { icon: Icon, tone } = fileIcon(entry.name, entry.kind, expanded);

  return (
    <li
      role="treeitem"
      aria-label={entry.name}
      aria-level={depth}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      data-path={entry.path}
      tabIndex={active === entry.path ? 0 : -1}
      className="group/row outline-none"
      onFocus={(event) => {
        if (event.target === event.currentTarget) setActive(entry.path);
      }}
      onClick={(event) => {
        event.stopPropagation();
        activate();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        } else if (isDir && event.key === (expanded ? "ArrowLeft" : "ArrowRight")) {
          event.preventDefault();
          toggle(threadId, entry.path);
        }
      }}
    >
      <div
        title={entry.path}
        style={indent(depth)}
        className={cn(
          "flex h-(--space-row) cursor-default items-center gap-1.5 rounded-md pe-2 hover:bg-accent group-focus-visible/row:ring-2 group-focus-visible/row:ring-ring/50",
          selected && "bg-accent text-foreground",
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-(--dur-move-fast)",
            !isDir && "invisible",
            expanded && "rotate-90",
          )}
        />
        <Icon aria-hidden className={cn("size-3.5 shrink-0", tone)} />
        <span className="min-w-0 truncate">{entry.name}</span>
      </div>
      {isDir && expanded && (
        <ul role="group">
          <TreeLevel threadId={threadId} path={entry.path} depth={depth + 1} />
        </ul>
      )}
    </li>
  );
}

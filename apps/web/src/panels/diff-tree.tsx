import type { DiffFile } from "@gram/contracts";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { FILE_STATUS } from "./diff-files";
import type { DiffTreeNode } from "./diff-tree-model";
import { treeKeyDown } from "./files/file-tree";

const indent = (depth: number) => ({ paddingInlineStart: `${(depth - 1) * 12 + 4}px` });

/**
 * The changed files as a folder tree, each with its status and +/− counts; choosing one calls
 * `onJump`. Folders start open. One Tab stop, with the Files panel's keys: ↑ ↓ Home End move, → / ←
 * open and close a folder or step into and out of it, ⏎ jumps to a file.
 */
export function DiffTree({
  nodes,
  selected,
  onJump,
  className,
}: {
  nodes: readonly DiffTreeNode[];
  selected: string | undefined;
  onJump: (path: string) => void;
  className?: string;
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string>();
  const treeRef = useRef<HTMLUListElement>(null);
  const toggle = (path: string) =>
    setClosed((set) => {
      const next = new Set(set);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  // The active item may be gone (its folder closed, the diff changed): the first item takes the Tab stop.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree || tree.querySelector('[role="treeitem"][tabindex="0"]')) return;
    const first = tree.querySelector<HTMLElement>('[role="treeitem"]')?.dataset["key"];
    if (first !== undefined && first !== active) setActive(first);
  });

  const level = (items: readonly DiffTreeNode[], depth: number) =>
    items.map((node) => {
      const key = node.kind === "dir" ? `dir:${node.path}` : node.file.path;
      const common = {
        role: "treeitem",
        "aria-level": depth,
        "data-key": key,
        tabIndex: active === key ? 0 : -1,
        className: "group/row outline-none",
        onFocus: (event: FocusEvent<HTMLLIElement>) => {
          if (event.target === event.currentTarget) setActive(key);
        },
      } as const;
      if (node.kind === "dir") {
        const open = !closed.has(node.path);
        return (
          <li
            key={key}
            {...common}
            aria-label={node.name}
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              toggle(node.path);
            }}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (
                event.key === "Enter" ||
                event.key === " " ||
                event.key === (open ? "ArrowLeft" : "ArrowRight")
              ) {
                event.preventDefault();
                toggle(node.path);
              }
            }}
          >
            <Row depth={depth} title={node.path}>
              <ChevronRight
                aria-hidden
                className={cn(
                  "size-3 shrink-0 text-muted-foreground transition-transform duration-(--dur-move-fast)",
                  open && "rotate-90",
                )}
              />
              {open ? (
                <FolderOpen aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 truncate">{node.name}</span>
            </Row>
            {open && <ul role="group">{level(node.children, depth + 1)}</ul>}
          </li>
        );
      }
      return (
        <li
          key={key}
          {...common}
          aria-label={node.name}
          aria-selected={selected === node.file.path}
          onClick={(event) => {
            event.stopPropagation();
            onJump(node.file.path);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onJump(node.file.path);
            }
          }}
        >
          <FileRow
            file={node.file}
            name={node.name}
            depth={depth}
            selected={selected === node.file.path}
          />
        </li>
      );
    });

  return (
    <ul
      ref={treeRef}
      role="tree"
      aria-label="Changed files"
      data-testid="diff-tree"
      className={cn("p-1 text-xs", className)}
      onKeyDown={treeKeyDown}
    >
      {level(nodes, 1)}
    </ul>
  );
}

function Row({
  depth,
  title,
  selected = false,
  children,
}: {
  depth: number;
  title: string;
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      title={title}
      style={indent(depth)}
      className={cn(
        "flex h-6 cursor-default items-center gap-1.5 rounded-sm pe-1.5 hover:bg-accent group-focus-visible/row:ring-2 group-focus-visible/row:ring-ring/50",
        selected && "bg-accent text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function FileRow({
  file,
  name,
  depth,
  selected,
}: {
  file: DiffFile;
  name: string;
  depth: number;
  selected: boolean;
}) {
  const status = FILE_STATUS[file.status];
  return (
    <Row depth={depth} title={`${file.path} · ${status.label}`} selected={selected}>
      <span aria-hidden className="size-3 shrink-0" />
      <status.icon aria-hidden className={cn("size-3.5 shrink-0", status.tone)} />
      <span className="sr-only">{status.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
      {(file.additions > 0 || file.deletions > 0) && (
        <span className="shrink-0 font-mono tabular-nums">
          {file.additions > 0 && (
            <span className="text-success">+{file.additions.toLocaleString()}</span>
          )}
          {file.additions > 0 && file.deletions > 0 && " "}
          {file.deletions > 0 && (
            <span className="text-destructive">−{file.deletions.toLocaleString()}</span>
          )}
        </span>
      )}
    </Row>
  );
}

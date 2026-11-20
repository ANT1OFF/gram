import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/** One entry of a `TreeList`, with the entries under it. */
export interface TreeNode {
  /** Stable among the whole tree's entries. */
  readonly id: string;
  /** The entry's name, which its fold button says to a screen reader. */
  readonly label: string;
  /** What the entry draws: a row, a heading. Its `label` when left out. */
  readonly content?: ReactNode;
  readonly children?: readonly TreeNode[];
}

export interface TreeListProps {
  nodes: readonly TreeNode[];
  /** The list's name for a screen reader. */
  label: string;
  /** The ids of the open entries, for a tree you keep the folds of yourself. */
  expanded?: ReadonlySet<string>;
  onExpandedChange?: (expanded: ReadonlySet<string>) => void;
  /** Which entries start open when you don't keep them: every one (`all`, the default) or these. */
  defaultExpanded?: "all" | readonly string[];
  /** Lines from each entry to the ones under it. On by default. */
  connectors?: boolean;
  className?: string;
  testId?: string;
}

const everyParent = (nodes: readonly TreeNode[]): string[] =>
  nodes.flatMap((node) =>
    node.children !== undefined && node.children.length > 0
      ? [node.id, ...everyParent(node.children)]
      : [],
  );

const LINE = "pointer-events-none absolute w-px bg-border";

function TreeItem({
  node,
  depth,
  last,
  open,
  toggle,
  connectors,
}: {
  node: TreeNode;
  depth: number;
  last: boolean;
  open: (id: string) => boolean;
  toggle: (id: string) => void;
  connectors: boolean;
}) {
  const rows = useId();
  const parent = node.children !== undefined && node.children.length > 0;
  const expanded = parent && open(node.id);
  const nested = connectors && depth > 0;
  return (
    <li className="relative" data-testid="tree-item" data-depth={depth}>
      {nested && !last && <span aria-hidden className={cn(LINE, "top-0 bottom-0 -left-3")} />}
      <div className="relative flex min-w-0 items-center">
        {nested && (
          <>
            <span aria-hidden className={cn(LINE, "top-0 h-1/2 -left-3")} />
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 -left-3 h-px w-3 bg-border"
            />
          </>
        )}
        {connectors && expanded && (
          <span aria-hidden className={cn(LINE, "top-[calc(50%+0.5rem)] bottom-0 left-3")} />
        )}
        {parent ? (
          <button
            type="button"
            data-testid="tree-toggle"
            aria-label={node.label}
            aria-expanded={expanded}
            aria-controls={rows}
            onClick={() => toggle(node.id)}
            className="relative grid size-6 shrink-0 place-items-center rounded-(--radius-sm) text-muted-foreground outline-none transition-colors duration-(--dur-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 transition-transform duration-(--dur-fast)",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          <span aria-hidden className="w-6 shrink-0" />
        )}
        <div className="min-w-0 flex-1">{node.content ?? node.label}</div>
      </div>
      {parent && (
        <ul id={rows} hidden={!expanded} className="ml-3 flex flex-col pl-3">
          {node.children?.map((child, index, all) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              last={index === all.length - 1}
              open={open}
              toggle={toggle}
              connectors={connectors}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A tree of entries, each indented under the one it belongs to, with lines joining them and a
 * button that folds an entry's children.
 */
export function TreeList({
  nodes,
  label,
  expanded,
  onExpandedChange,
  defaultExpanded = "all",
  connectors = true,
  className,
  testId,
}: TreeListProps) {
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(() => new Set());
  const startsOpen = (id: string) => defaultExpanded === "all" || defaultExpanded.includes(id);
  const open = (id: string) => expanded?.has(id) ?? startsOpen(id) !== flipped.has(id);
  const toggle = (id: string) => {
    if (expanded === undefined) {
      const next = new Set(flipped);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setFlipped(next);
    }
    onExpandedChange?.(
      new Set(everyParent(nodes).filter((each) => (each === id ? !open(each) : open(each)))),
    );
  };
  return (
    <ul aria-label={label} data-testid={testId} className={cn("flex flex-col", className)}>
      {nodes.map((node, index) => (
        <TreeItem
          key={node.id}
          node={node}
          depth={0}
          last={index === nodes.length - 1}
          open={open}
          toggle={toggle}
          connectors={connectors}
        />
      ))}
    </ul>
  );
}

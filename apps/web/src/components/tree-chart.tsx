import { Maximize2, Minus, Plus } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useLayoutSync } from "@/lib/effects";
import { cn } from "@/lib/utils";

import type { TreeNode } from "./tree-list";

export interface TreeChartProps {
  nodes: readonly TreeNode[];
  /** The chart's name for a screen reader. */
  label: string;
  /** The ids of the open entries, for a chart you keep the folds of yourself. */
  expanded?: ReadonlySet<string>;
  onExpandedChange?: (expanded: ReadonlySet<string>) => void;
  /** Which entries start open when you don't keep them: these, or only the top ones by default. */
  defaultExpanded?: readonly string[];
  /** The entry to bring into view and draw as chosen. */
  focusId?: string;
  /** A box's size in pixels at 100 %. */
  nodeWidth?: number;
  nodeHeight?: number;
  /** The chart's height on the page, such as `32rem`. */
  height?: string;
  /**
   * Children that open nothing themselves stand in one column under their box, as an organisation
   * chart lists a lead's reports, rather than side by side. On by default.
   */
  stackLeaves?: boolean;
  /** Opens zoomed out to fit its frame, never below half size, then brings `focusId` into view. */
  fit?: boolean;
  /**
   * `vertical` draws the top at the top with children below; `horizontal` draws the top at the left
   * with children in a column to its right, which suits a wide frame and many siblings.
   */
  orientation?: "vertical" | "horizontal";
  /**
   * Opens zoomed so `focusId` shows with the entries above it and its open children, never below
   * three quarters size, and draws the entries off that line dimmer.
   */
  fitFocus?: boolean;
  className?: string;
  testId?: string;
}

const GAP_X = 16;
const GAP_Y = 40;
const GAP_STACK = 8;
const INDENT = 24;
const FIT_FLOOR = 0.5;
const FOCUS_FLOOR = 0.75;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;

export interface Placed {
  readonly node: TreeNode;
  readonly x: number;
  readonly y: number;
  /** The box above it, where its line starts. */
  readonly parent?: { readonly x: number; readonly y: number };
  /** It stands in a column under its parent, joined from the parent's left side. */
  readonly stacked?: boolean;
  /** How many entries are folded away under it. */
  readonly hidden: number;
}

/** The ids from the top down to `id`, `id` included; empty when it is not in the tree. */
export const pathTo = (nodes: readonly TreeNode[], id: string): string[] => {
  for (const node of nodes) {
    if (node.id === id) return [node.id];
    const below = pathTo(node.children ?? [], id);
    if (below.length > 0) return [node.id, ...below];
  }
  return [];
};

const countAll = (node: TreeNode): number =>
  (node.children ?? []).reduce((sum, child) => sum + 1 + countAll(child), 0);

/**
 * Lays the open part of a tree out top-down: each leaf in the next free column, each parent over
 * the middle of its children. With `stack`, children that open nothing stand in one column under
 * their parent instead. Folded entries are left out, so a large tree draws only what is open.
 */
export function layOut(
  nodes: readonly TreeNode[],
  open: (id: string) => boolean,
  width: number,
  height: number,
  stack = false,
): { placed: Placed[]; width: number; height: number } {
  const placed: Placed[] = [];
  let column = 0;
  let bottom = 0;
  const shownChildren = (node: TreeNode) => (open(node.id) ? (node.children ?? []) : []);
  const place = (
    node: TreeNode,
    y: number,
    parent: { x: number; y: number } | undefined,
  ): number => {
    bottom = Math.max(bottom, y + height);
    const children = shownChildren(node);
    const at = placed.length;
    placed.push({ node, x: 0, y, hidden: children.length === 0 ? countAll(node) : 0 });
    let x: number;
    if (children.length === 0) {
      x = column * (width + GAP_X);
      column += 1;
    } else if (stack && children.every((child) => shownChildren(child).length === 0)) {
      x = column * (width + GAP_X);
      column += 1;
      children.forEach((child, index) => {
        const childY = y + (index + 1) * (height + GAP_STACK) + GAP_STACK;
        bottom = Math.max(bottom, childY + height);
        placed.push({
          node: child,
          x: x + INDENT,
          y: childY,
          parent: { x, y },
          stacked: true,
          hidden: countAll(child),
        });
      });
      if (children.length > 0) column += INDENT / (width + GAP_X);
    } else {
      const under = children.map((child) => place(child, y + height + GAP_Y, undefined));
      x = (under[0]! + under.at(-1)!) / 2;
    }
    placed[at] = { ...placed[at]!, x, ...(parent === undefined ? {} : { parent }) };
    for (const entry of placed.slice(at + 1))
      if (!entry.stacked && entry.parent === undefined && entry.y === y + height + GAP_Y)
        Object.assign(entry, { parent: { x, y } });
    return x;
  };
  for (const node of nodes) place(node, 0, undefined);
  return {
    placed,
    width: Math.max(width, column * (width + GAP_X) - GAP_X),
    height: bottom,
  };
}

/**
 * A tree drawn top-down as boxes joined by lines, as an organisation chart is: zoom in and out,
 * fit it to its frame, scroll or drag to move about, and open or fold each box's children with
 * the button under it. Only the open part is drawn.
 */
export function TreeChart({
  nodes,
  label,
  expanded,
  onExpandedChange,
  defaultExpanded,
  focusId,
  nodeWidth = 224,
  nodeHeight = 64,
  height = "32rem",
  stackLeaves = true,
  fit: fitted = false,
  orientation = "vertical",
  fitFocus = false,
  className,
  testId,
}: TreeChartProps) {
  const [own, setOwn] = useState<ReadonlySet<string>>(
    () => new Set(defaultExpanded ?? nodes.map((node) => node.id)),
  );
  const shown = expanded ?? own;
  const open = (id: string) => shown.has(id);
  const [zoom, setZoom] = useState(1);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  const across = orientation === "horizontal";
  const laid = across
    ? layOut(nodes, open, nodeHeight, nodeWidth, false)
    : layOut(nodes, open, nodeWidth, nodeHeight, stackLeaves);
  const placed: Placed[] = across
    ? laid.placed.map((entry) => ({
        ...entry,
        x: entry.y,
        y: entry.x,
        ...(entry.parent === undefined ? {} : { parent: { x: entry.parent.y, y: entry.parent.x } }),
      }))
    : laid.placed;
  const width = across ? laid.height : laid.width;
  const tall = across ? laid.width : laid.height;
  const line = focusId === undefined ? [] : pathTo(nodes, focusId);
  const onLine = new Set(line);
  const focusNode = placed.find((entry) => entry.node.id === focusId);
  for (const child of focusNode !== undefined && open(focusNode.node.id)
    ? (focusNode.node.children ?? [])
    : [])
    onLine.add(child.id);
  const region = placed.filter((entry) => onLine.has(entry.node.id));
  const left0 = Math.min(...region.map((entry) => entry.x));
  const right0 = Math.max(...region.map((entry) => entry.x + nodeWidth));
  const top0 = Math.min(...region.map((entry) => entry.y));
  const bottom0 = Math.max(...region.map((entry) => entry.y + nodeHeight));
  const toggle = (id: string) => {
    const next = new Set(shown);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (expanded === undefined) setOwn(next);
    onExpandedChange?.(next);
  };
  const clamp = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  const fit = () => {
    const box = frame.current;
    if (box === null) return;
    setZoom(clamp(Math.min((box.clientWidth - 32) / width, (box.clientHeight - 32) / tall)));
  };
  const fittedOnce = useRef(false);
  const holdFrame = (box: HTMLDivElement | null) => {
    frame.current = box;
    if (box === null || !fitted || fittedOnce.current) return;
    fittedOnce.current = true;
    const whole = Math.min((box.clientWidth - 32) / width, (box.clientHeight - 32) / tall, 1);
    setZoom(clamp(Math.max(FIT_FLOOR, whole)));
  };
  const focusedOnce = useRef(false);
  const holdFocusFrame = (box: HTMLDivElement | null) => {
    holdFrame(box);
    if (box === null || !fitFocus || focusedOnce.current || region.length === 0) return;
    focusedOnce.current = true;
    const spans = Math.min(
      (box.clientWidth - 32) / (right0 - left0),
      (box.clientHeight - 32) / (bottom0 - top0),
      1,
    );
    setZoom(clamp(Math.max(FOCUS_FLOOR, spans)));
  };
  const focused = placed.find((entry) => entry.node.id === focusId);
  const regionFits = (box: HTMLElement) =>
    fitFocus &&
    region.length > 0 &&
    (right0 - left0) * zoom <= box.clientWidth - 32 &&
    (bottom0 - top0) * zoom <= box.clientHeight - 32;
  const scrollKey =
    focused === undefined ? undefined : `${focused.x}:${focused.y}:${zoom}:${region.length}`;
  useLayoutSync(() => {
    const box = frame.current;
    if (box === null || focused === undefined) return;
    if (regionFits(box)) {
      box.scrollLeft = Math.max(0, ((left0 + right0) / 2) * zoom - box.clientWidth / 2);
      box.scrollTop = Math.max(0, ((top0 + bottom0) / 2) * zoom - box.clientHeight / 2);
      return;
    }
    box.scrollLeft = Math.max(0, (focused.x + nodeWidth / 2) * zoom - box.clientWidth / 2);
    box.scrollTop = Math.max(
      0,
      (across ? focused.y + nodeHeight / 2 : focused.y) * zoom -
        (across ? box.clientHeight / 2 : 48),
    );
  }, [scrollKey]);
  return (
    <div className={cn("flex flex-col gap-2", className)} data-testid={testId}>
      <div className="flex items-center gap-1" role="group" aria-label={`${label}: zoom`}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((now) => clamp(now - 0.15))}
        >
          <Minus aria-hidden />
        </Button>
        <span className="w-12 text-center text-meta text-muted-foreground tabular-nums">
          {Math.round(zoom * 100)} %
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((now) => clamp(now + 0.15))}
        >
          <Plus aria-hidden />
        </Button>
        <Button variant="ghost" size="sm" onClick={fit}>
          <Maximize2 aria-hidden />
          Fit
        </Button>
      </div>
      <div
        ref={holdFocusFrame}
        role="tree"
        aria-label={label}
        className="relative cursor-grab overflow-auto rounded-lg border border-edge-group bg-card active:cursor-grabbing"
        style={{ height }}
        onPointerDown={(event) => {
          if ((event.target as Element).closest("button, a, input")) return;
          const box = frame.current;
          if (box === null) return;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: box.scrollLeft,
            top: box.scrollTop,
          };
        }}
        onPointerMove={(event) => {
          const box = frame.current;
          const from = drag.current;
          if (box === null || from === undefined) return;
          box.scrollLeft = from.left - (event.clientX - from.x);
          box.scrollTop = from.top - (event.clientY - from.y);
        }}
        onPointerUp={() => {
          drag.current = undefined;
        }}
        onPointerLeave={() => {
          drag.current = undefined;
        }}
      >
        <div className="relative" style={{ width: width * zoom + 32, height: tall * zoom + 56 }}>
          <div
            className="absolute top-4 left-4 origin-top-left"
            style={{ width, height: tall, transform: `scale(${zoom})` }}
          >
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0 overflow-visible text-border"
              width={width}
              height={tall}
            >
              {placed.map((entry) =>
                entry.parent === undefined ? null : (
                  <path
                    key={entry.node.id}
                    d={
                      across
                        ? `M${entry.parent.x + nodeWidth},${entry.parent.y + nodeHeight / 2} H${entry.x - GAP_Y / 2} V${entry.y + nodeHeight / 2} H${entry.x}`
                        : entry.stacked
                          ? `M${entry.parent.x + INDENT / 2},${entry.parent.y + nodeHeight} V${entry.y + nodeHeight / 2} H${entry.x}`
                          : `M${entry.parent.x + nodeWidth / 2},${entry.parent.y + nodeHeight} V${entry.y - GAP_Y / 2} H${entry.x + nodeWidth / 2} V${entry.y}`
                    }
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1}
                  />
                ),
              )}
            </svg>
            {placed.map((entry) => {
              const children = entry.node.children ?? [];
              const isOpen = children.length > 0 && open(entry.node.id);
              return (
                <div
                  key={entry.node.id}
                  role="treeitem"
                  aria-label={entry.node.label}
                  aria-expanded={children.length > 0 ? isOpen : undefined}
                  aria-selected={entry.node.id === focusId}
                  data-testid="tree-chart-node"
                  className={cn(
                    "absolute flex flex-col justify-center overflow-hidden rounded-md border bg-background px-2",
                    entry.node.id === focusId ? "border-ring ring-2 ring-ring" : "border-border",
                    fitFocus && focusId !== undefined && !onLine.has(entry.node.id) && "opacity-50",
                  )}
                  style={{ left: entry.x, top: entry.y, width: nodeWidth, height: nodeHeight }}
                >
                  {entry.node.content ?? (
                    <span className="truncate text-body">{entry.node.label}</span>
                  )}
                  {children.length > 0 && (
                    <button
                      type="button"
                      data-testid="tree-chart-toggle"
                      aria-label={`${isOpen ? "Fold" : "Open"} ${entry.node.label}`}
                      onClick={() => toggle(entry.node.id)}
                      className="absolute right-1 bottom-1 rounded-(--radius-sm) border border-border bg-card px-1 text-meta text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {isOpen ? "−" : `+${entry.hidden}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

import { GRID_SHAPES, type ThreadId } from "@gram/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2, Minimize2, Plus, SquareDashed, X } from "lucide-react";
import {
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { focusOtherWindow } from "@/desktop/open-thread";
import { useShortcutHint } from "@/keyboard/use-shortcut-hint";
import { cn } from "@/lib/utils";
import { drawOn, GlideItem, GlideList, useMotionLevel } from "@/motion";
import { useListedThreads } from "@/sidebar/listed";
import { threadStatusOf } from "@/sidebar/status";
import { resizeFractions, useLayoutStore } from "@/stores/layout";
import { ThreadView } from "@/thread/thread-view";

import { hasPaneDrag, hasThreadDrag, PANE_DRAG_TYPE, THREAD_DRAG_TYPE } from "./drag";
import { focusPaneComposer } from "./pane-focus";

const INSTANT = { duration: 0 };
const KEYBOARD_STEP = 0.05;
const FULL = "minmax(0,1fr)";

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const even = (count: number) => Array.from({ length: count }, () => 1);
const template = (fr: readonly number[]) => fr.map((f) => `minmax(0,${f}fr)`).join(" ");

/** The pane grid: one thread per pane, the focused pane owns the keyboard, dividers resize. */
export function ThreadGrid() {
  const grid = useLayoutStore((s) => s.grid);
  const setFractions = useLayoutStore((s) => s.setFractions);
  const resetFractions = useLayoutStore((s) => s.resetFractions);
  const level = useMotionLevel();
  const [resizing, setResizing] = useState(false);

  const { cols, rows } = GRID_SHAPES[grid.preset];
  const colFr = grid.colFr ?? even(cols);
  const rowFr = grid.rowFr ?? even(rows);
  const multi = grid.panes.length > 1;
  const maximized = multi && grid.maximized;
  const instant = level !== "full" || resizing;

  return (
    <div
      className="relative flex min-h-0 flex-1"
      data-testid="thread-grid"
      data-preset={grid.preset}
      data-maximized={maximized}
    >
      <GlideList id="panes">
        <ul
          className="grid min-h-0 min-w-0 flex-1 gap-px bg-border"
          style={
            maximized
              ? { gridTemplateColumns: FULL, gridTemplateRows: FULL }
              : { gridTemplateColumns: template(colFr), gridTemplateRows: template(rowFr) }
          }
        >
          {grid.panes.map((threadId, index) => (
            <Pane
              key={threadId ?? `empty-${index}`}
              index={index}
              threadId={threadId}
              focused={index === grid.focused}
              multi={multi}
              maximized={maximized}
              hidden={maximized && index !== grid.focused}
              instant={instant}
            />
          ))}
        </ul>
      </GlideList>
      {!maximized && (
        <>
          {colFr.slice(1).map((_, index) => (
            <Divider
              key={`col-${index}`}
              axis="col"
              index={index}
              fr={colFr}
              onResize={(fr) => setFractions("col", fr)}
              onReset={resetFractions}
              onActive={setResizing}
            />
          ))}
          {rowFr.slice(1).map((_, index) => (
            <Divider
              key={`row-${index}`}
              axis="row"
              index={index}
              fr={rowFr}
              onResize={(fr) => setFractions("row", fr)}
              onReset={resetFractions}
              onActive={setResizing}
            />
          ))}
        </>
      )}
    </div>
  );
}

function Pane({
  index,
  threadId,
  focused,
  multi,
  maximized,
  hidden,
  instant,
}: {
  index: number;
  threadId: ThreadId | null;
  focused: boolean;
  multi: boolean;
  maximized: boolean;
  hidden: boolean;
  instant: boolean;
}) {
  const focusPane = useLayoutStore((s) => s.focusPane);
  const openInPane = useLayoutStore((s) => s.openInPane);
  const swapPanes = useLayoutStore((s) => s.swapPanes);
  const toggleMaximize = useLayoutStore((s) => s.toggleMaximize);
  const [dropping, setDropping] = useState(false);

  const onDragOver = (event: DragEvent<HTMLLIElement>) => {
    if (!hasThreadDrag(event) && !hasPaneDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropping(true);
  };

  const onDrop = (event: DragEvent<HTMLLIElement>) => {
    setDropping(false);
    const pane = event.dataTransfer.getData(PANE_DRAG_TYPE);
    if (pane !== "") {
      event.preventDefault();
      swapPanes(Number(pane), index);
      return;
    }
    const dropped = event.dataTransfer.getData(THREAD_DRAG_TYPE) as ThreadId;
    if (!dropped) return;
    event.preventDefault();
    if (!focusOtherWindow(dropped)) openInPane(dropped, index);
  };

  return (
    <GlideItem
      glideId={`pane-${threadId ?? `empty-${index}`}`}
      {...(instant ? { transition: INSTANT } : {})}
      data-testid="pane"
      data-pane-index={index}
      data-thread-id={threadId ?? undefined}
      data-focused={focused}
      aria-label={`Pane ${index + 1}`}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col bg-thread",
        hidden && "hidden",
        ((multi && focused) || dropping) &&
          "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:ring-2 after:ring-inset",
        dropping ? "after:bg-primary/10 after:ring-primary" : "after:ring-ring/70",
      )}
      onPointerDownCapture={() => focusPane(index)}
      onFocusCapture={() => focusPane(index)}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {threadId ? (
        <ThreadView
          threadId={threadId}
          focused={focused}
          actions={multi ? <PaneActions index={index} maximized={maximized} /> : undefined}
          {...(multi
            ? {
                onHeaderDoubleClick: toggleMaximize,
                onHeaderDragStart: (event: DragEvent<HTMLElement>) => {
                  event.dataTransfer.setData(PANE_DRAG_TYPE, String(index));
                  event.dataTransfer.effectAllowed = "move";
                },
              }
            : {})}
        />
      ) : (
        <EmptyPane index={index} />
      )}
    </GlideItem>
  );
}

function PaneActions({ index, maximized }: { index: number; maximized: boolean }) {
  const closePane = useLayoutStore((s) => s.closePane);
  const toggleMaximize = useLayoutStore((s) => s.toggleMaximize);
  const maximizeLabel = maximized ? "Restore grid" : "Maximize pane";
  const maximizeHint = useShortcutHint("pane.maximize");

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <kbd className="px-1 font-mono text-[10px] text-muted-foreground @max-sm:hidden">
        {index + 1}
      </kbd>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={maximizeLabel}
        title={`${maximizeLabel} (${maximizeHint ? `${maximizeHint}, or ` : ""}double-click the header)`}
        onClick={toggleMaximize}
      >
        {maximized ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close pane"
        onClick={() => {
          closePane(index);
          focusPaneComposer(useLayoutStore.getState().grid.focused, { always: true });
        }}
      >
        <X />
      </Button>
    </span>
  );
}

/** How many recent threads an empty pane offers. */
const EMPTY_PANE_THREADS = 6;

/** An empty pane: start a thread that lands here, or open a recent thread that isn't on screen. */
function EmptyPane({ index }: { index: number }) {
  const navigate = useNavigate();
  const panes = useLayoutStore((s) => s.grid.panes);
  const byId = useListedThreads();
  const recent = Object.values(byId)
    .filter((s) => !s.thread.parked && !panes.includes(s.thread.id))
    .toSorted((a, b) => b.thread.lastActivityAt - a.thread.lastActivityAt)
    .slice(0, EMPTY_PANE_THREADS);

  const open = (threadId: ThreadId) => {
    if (focusOtherWindow(threadId)) return;
    useLayoutStore.getState().openInPane(threadId, index);
    void navigate({ to: "/t/$threadId", params: { threadId } });
  };

  // The new thread opens in the focused pane once it's created, so focus this one first.
  const newThread = () => {
    useLayoutStore.getState().focusPane(index);
    void navigate({ to: "/new" });
  };

  return (
    <div data-testid="empty-pane" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-10 shrink-0 items-center border-b border-border px-4 text-sm text-muted-foreground">
        Pane {index + 1}
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-y-auto p-6 text-center text-sm text-muted-foreground">
        <SquareDashed aria-hidden ref={drawOn} strokeWidth={1.5} className="size-6 opacity-70" />
        <p>Empty pane</p>
        <Button variant="outline" size="sm" onClick={newThread}>
          <Plus data-icon="inline-start" />
          New thread here
        </Button>
        {recent.length > 0 && (
          <section aria-label="Open a thread here" className="flex w-full max-w-64 flex-col gap-1">
            <h3 className="text-[11px] font-medium tracking-wide uppercase">Open a thread here</h3>
            <ul className="flex flex-col">
              {recent.map((summary) => {
                const { thread } = summary;
                const display = threadStatusOf(summary);
                return (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => open(thread.id)}
                      className="flex w-full min-w-0 items-center gap-1.5 rounded-(--radius-sm) px-2 py-1 text-left text-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <display.icon aria-hidden className={cn("size-3.5 shrink-0", display.tone)} />
                      <span className="truncate">{thread.title}</span>
                      <span className="sr-only">, {display.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <p className="text-xs">Or drag a thread here from the sidebar.</p>
      </div>
    </div>
  );
}

function Divider({
  axis,
  index,
  fr,
  onResize,
  onReset,
  onActive,
}: {
  axis: "col" | "row";
  index: number;
  fr: readonly number[];
  onResize: (fr: number[]) => void;
  onReset: () => void;
  onActive: (active: boolean) => void;
}) {
  const col = axis === "col";
  const total = sum(fr);
  const before = sum(fr.slice(0, index)) / total;
  const pairTotal = fr[index]! + fr[index + 1]!;
  const pair = pairTotal / total;
  const share = fr[index]! / pairTotal;
  const offset = (before + pair * share) * 100;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const area = event.currentTarget.parentElement;
    if (!area || event.button !== 0) return;
    event.preventDefault();
    const rect = area.getBoundingClientRect();
    const start = col ? rect.left : rect.top;
    const size = col ? rect.width : rect.height;
    onActive(true);
    const move = (moveEvent: PointerEvent) => {
      const position = ((col ? moveEvent.clientX : moveEvent.clientY) - start) / size;
      onResize(resizeFractions(fr, index, (position - before) / pair));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      onActive(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const back = col ? "ArrowLeft" : "ArrowUp";
    const forward = col ? "ArrowRight" : "ArrowDown";
    const step = event.key === back ? -KEYBOARD_STEP : event.key === forward ? KEYBOARD_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onResize(resizeFractions(fr, index, share + step));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={col ? "vertical" : "horizontal"}
      aria-label={`Resize ${col ? "columns" : "rows"} ${index + 1} and ${index + 2}`}
      aria-valuenow={Math.round(share * 100)}
      title="Drag to resize, double-click to reset"
      data-testid="divider"
      className={cn(
        "absolute z-30 outline-none hover:bg-ring/40 focus-visible:bg-ring/50",
        col
          ? "inset-y-0 w-1.5 -translate-x-1/2 cursor-col-resize"
          : "inset-x-0 h-1.5 -translate-y-1/2 cursor-row-resize",
      )}
      style={col ? { left: `${offset}%` } : { top: `${offset}%` }}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

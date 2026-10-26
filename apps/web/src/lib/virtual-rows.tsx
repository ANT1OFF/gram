import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

// A list that draws only the rows near its scroller's view, inside a scroller it shares with other
// content (the overview's sections, the Board's lines). Rows keep their own height, measured as they
// draw. The row last focused and one being dragged stay drawn wherever they scroll to, so focus that
// comes back to a row and a drag's end both still find it. Tab and Shift+Tab go on to the next or
// previous row by index, drawing it first; other keys that walk rows do the same through
// `virtualRowOf` and `revealVirtualRow`, since a row's neighbour may not be drawn.

/** Marks a virtualized list's root; each drawn row carries its index as `data-index`. */
export const VIRTUAL_LIST = "data-virtual-list";

interface ListHandle {
  readonly count: number;
  /** The row that counts as the current one, or -1. */
  readonly current: number;
  scrollTo: (index: number) => void;
}

const handles = new WeakMap<Element, ListHandle>();

/** Where a drawn row goes: what a `bare` list's rows spread on their own root. */
export interface RowPlace {
  ref: (element: HTMLElement | null) => void;
  "data-index": number;
  className: string;
  style: CSSProperties;
}

const TABBABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** What Tab stops on in `row`. */
const tabStops = (row: Element): HTMLElement[] =>
  [...row.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0 && element.closest("[hidden], [inert]") === null,
  );

/** The nearest ancestor that scrolls vertically. */
const scrollParent = (element: HTMLElement | null): HTMLElement | null => {
  for (let at = element?.parentElement ?? null; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
};

/** Where `list` starts in its scroller's content; undefined while it isn't laid out. */
const offsetIn = (list: HTMLElement, scroller: HTMLElement): number | undefined => {
  if (list.getClientRects().length === 0) return undefined;
  return (
    list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
};

/**
 * A drawn row's height to the fraction of a pixel, as the page lays it out: the virtualizer's own
 * measure rounds it, and a 27.5 px row placed at 28 px would push each row under it half a pixel
 * further down. While the list is hidden (a folded section, the closed Parked line) its rows have
 * no box, and keep what was known of them rather than 0, so showing the list moves nothing.
 */
function measureShown(
  element: HTMLElement,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLElement, HTMLElement>,
): number {
  const index = instance.indexFromElement(element);
  const key = instance.options.getItemKey(index);
  if (element.getClientRects().length === 0) {
    return instance.itemSizeCache.get(key) ?? instance.options.estimateSize(index);
  }
  const size = entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;
  // The virtualizer keeps a measure only when it differs from the size it assumed. A row as tall
  // as the estimate would then follow the estimate when it changes (the drawn rows' average), so
  // it is kept here.
  if (!instance.itemSizeCache.has(key) && instance.measurementsCache[index]?.size === size) {
    instance.itemSizeCache.set(key, size);
  }
  return size;
}

/** The average height of the rows measured so far, or undefined before any is. */
function typicalSize(
  instance: Virtualizer<HTMLElement, HTMLElement> | undefined,
): number | undefined {
  if (instance === undefined || instance.itemSizeCache.size === 0) return undefined;
  let sum = 0;
  for (const size of instance.itemSizeCache.values()) sum += size;
  return sum / instance.itemSizeCache.size;
}

export function VirtualRows<T>({
  items,
  rowKey,
  estimate,
  gap = 0,
  current = -1,
  retainedKeys,
  overscan = 8,
  as: List = "div",
  label,
  bare = false,
  className,
  children,
}: {
  items: readonly T[];
  rowKey: (item: T) => string;
  /** A row's height before it has drawn, in pixels. */
  estimate: number;
  /** The space between rows, in pixels, as the list's `gap` would leave it. */
  gap?: number;
  /** The index of the row that counts as current (`aria-current`), for a jump to it; -1 for none. */
  current?: number;
  /** Rows with local state that must survive scrolling, such as an open plan editor. */
  retainedKeys?: ReadonlySet<string>;
  overscan?: number;
  /** A `ul` for rows that are list items (`bare`, each an `li`). */
  as?: "div" | "ul";
  label?: string;
  /** The rows spread `place` on their own root rather than being wrapped in a div. */
  bare?: boolean;
  className?: string;
  children: (item: T, index: number, place: RowPlace) => ReactNode;
}) {
  // The virtualizer is a mutable instance; the compiler must not memoize around it.
  "use no memo";
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  // By key: the rows reorder (latest first) under them.
  const [focused, setFocused] = useState<string>();
  const [dragged, setDragged] = useState<string>();
  const keep = new Set<number>();
  for (const key of [focused, dragged, ...(retainedKeys ?? [])]) {
    if (key === undefined) continue;
    const index = items.findIndex((item) => rowKey(item) === key);
    if (index !== -1) keep.add(index);
  }
  const rangeExtractor = (range: Range) => {
    const drawn = defaultRangeExtractor(range);
    if (keep.size === 0) return drawn;
    return [...new Set([...drawn, ...keep])].toSorted((a, b) => a - b);
  };

  const virtualizerRef = useRef<Virtualizer<HTMLElement, HTMLElement>>(undefined);
  const typical = typicalSize(virtualizerRef.current) ?? estimate;
  // oxlint-disable-next-line react/incompatible-library -- opted out of memoization above
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: items.length,
    getScrollElement: () => (scroller.current ??= scrollParent(root.current)),
    // Rows not drawn yet are as tall as the drawn ones are on average: the given estimate is only a
    // first guess, and each row off from it by half a pixel moves the rows under it.
    estimateSize: () => typical,
    getItemKey: (index) => (items[index] === undefined ? index : rowKey(items[index])),
    gap,
    overscan,
    scrollMargin: margin,
    rangeExtractor,
    measureElement: measureShown,
  });
  virtualizerRef.current = virtualizer;

  // What sits above the list in the scroller moves where it starts: a section folding, a workspace
  // opening, the window resizing. Scrolled into the list, the rows in view stay where they are, as
  // the browser's scroll anchoring keeps rows in flow, which it doesn't do for placed ones.
  useLayoutEffect(() => {
    const list = root.current;
    const parent = (scroller.current ??= scrollParent(list));
    if (list === null || parent === null) return;
    // Where the list starts against the scroller's top edge, last seen.
    let seen: number | undefined;
    const measure = () => {
      const offset = offsetIn(list, parent);
      if (offset === undefined) return;
      const at = offset - parent.scrollTop;
      if (seen !== undefined && seen < 0 && Math.abs(at - seen) >= 0.5) {
        parent.scrollTop += at - seen;
      }
      seen = offset - parent.scrollTop;
      setMargin((was) => (Math.abs(was - offset) < 0.5 ? was : offset));
    };
    const scrolled = () => {
      const offset = offsetIn(list, parent);
      if (offset !== undefined) seen = offset - parent.scrollTop;
    };
    measure();
    parent.addEventListener("scroll", scrolled, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => parent.removeEventListener("scroll", scrolled);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(parent);
    for (const child of parent.children) observer.observe(child);
    // A section turned on or off in Settings comes and goes as a child of its own.
    const added = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) observer.observe(node);
      }
      measure();
    });
    added.observe(parent, { childList: true });
    return () => {
      observer.disconnect();
      added.disconnect();
      parent.removeEventListener("scroll", scrolled);
    };
  }, []);

  useLayoutEffect(() => {
    const list = root.current;
    if (list === null) return;
    handles.set(list, {
      count: items.length,
      current,
      scrollTo: (index) => virtualizer.scrollToIndex(index, { align: "auto" }),
    });
  });

  const rowAt = (target: EventTarget) =>
    target instanceof Element
      ? target.closest<HTMLElement>(`[${VIRTUAL_LIST}] > [data-index]`)
      : null;
  const keyAt = (target: EventTarget) => {
    const row = rowAt(target);
    if (row === null || row.parentElement !== root.current) return undefined;
    const item = items[Number(row.dataset["index"])];
    return item === undefined ? undefined : rowKey(item);
  };

  // Tab from a row's last stop goes to the next row's first, drawn if it wasn't; Shift+Tab back.
  // Out of the list's ends, the page's own order takes over.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey) return;
    const list = root.current;
    const at = event.target instanceof Element ? virtualRowOf(event.target) : undefined;
    if (list === null || at === undefined || at.list !== list) return;
    const back = event.shiftKey;
    const stops = tabStops(at.row);
    if (event.target !== (back ? stops[0] : stops.at(-1))) return;
    const next = at.index + (back ? -1 : 1);
    if (next < 0 || next >= items.length) return;
    event.preventDefault();
    void revealVirtualRow(list, next).then((row) => {
      const into = row === null ? [] : tabStops(row);
      (back ? into.at(-1) : into[0])?.focus();
    });
  };

  // Tabbed into from outside, the page's order lands on the first (or last) drawn row, which may
  // be far from the list's first (or last): the focus goes on to that one instead.
  const enterAtEnd = (target: EventTarget, from: EventTarget | null) => {
    const list = root.current;
    const row = rowAt(target);
    if (list === null || row === null || row.parentElement !== list) return;
    if (!(target instanceof HTMLElement) || !target.matches(":focus-visible")) return;
    if (!(from instanceof Node) || list.contains(from)) return;
    const forward = (from.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const drawn = [...list.querySelectorAll<HTMLElement>(":scope > [data-index]")];
    const edge = forward ? drawn[0] : drawn.at(-1);
    const index = Number(row.dataset["index"]);
    const want = forward ? 0 : items.length - 1;
    if (edge !== row || index === want) return;
    void revealVirtualRow(list, want).then((into) => {
      const stops = into === null ? [] : tabStops(into);
      (forward ? stops[0] : stops.at(-1))?.focus();
    });
  };

  return (
    <List
      ref={root as never}
      {...{ [VIRTUAL_LIST]: "" }}
      aria-label={label}
      className={cn("relative w-full shrink-0", className)}
      style={{ height: virtualizer.getTotalSize() }}
      onFocus={(event) => {
        const key = keyAt(event.target);
        if (key !== undefined && key !== focused) setFocused(key);
        enterAtEnd(event.target, event.relatedTarget);
      }}
      onKeyDown={onKeyDown}
      onDragStart={(event) => setDragged(keyAt(event.target))}
      onDragEnd={() => setDragged(undefined)}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const place: RowPlace = {
          ref: virtualizer.measureElement,
          "data-index": item.index,
          className: "absolute left-0 w-full",
          style: { top: item.start - margin },
        };
        if (bare)
          return (
            <Fragment key={item.key}>{children(items[item.index]!, item.index, place)}</Fragment>
          );
        return (
          <div key={item.key} {...place}>
            {children(items[item.index]!, item.index, place)}
          </div>
        );
      })}
    </List>
  );
}

/** The virtualized list `element` sits in, with the row it is in and that row's index. */
export function virtualRowOf(
  element: Element,
): { list: HTMLElement; row: HTMLElement; index: number; count: number } | undefined {
  const row = element.closest<HTMLElement>(`[${VIRTUAL_LIST}] > [data-index]`);
  const list = row?.parentElement;
  const handle = list === null || list === undefined ? undefined : handles.get(list);
  if (row === null || list === null || list === undefined || handle === undefined) return undefined;
  return { list, row, index: Number(row.dataset["index"]), count: handle.count };
}

/** The virtualized lists under `root`. */
export const virtualLists = (root: ParentNode): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(`[${VIRTUAL_LIST}]`)].filter((list) => handles.has(list));

/** The index of `list`'s current row, or -1. */
export const virtualCurrent = (list: Element): number => handles.get(list)?.current ?? -1;

/** `list`'s row `index` if it is drawn. */
export const drawnVirtualRow = (list: Element, index: number): HTMLElement | null =>
  list.querySelector<HTMLElement>(`:scope > [data-index="${index}"]`);

/** Scrolls `list`'s row `index` into view, so it draws. */
export const scrollVirtualRow = (list: Element, index: number): void =>
  handles.get(list)?.scrollTo(index);

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Scrolls `list`'s row `index` into view and resolves with it once it has drawn, else null. */
export async function revealVirtualRow(
  list: Element,
  index: number,
  frames = 10,
): Promise<HTMLElement | null> {
  scrollVirtualRow(list, index);
  for (let frame = 0; frame < frames; frame++) {
    const row = drawnVirtualRow(list, index);
    if (row !== null) return row;
    await nextFrame();
  }
  return null;
}

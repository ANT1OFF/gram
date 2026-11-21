import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
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
import { painted } from "@/lib/timers";

/** Marks a virtualized list's root; each drawn row carries its index as `data-index`. */
export const VIRTUAL_LIST = "data-virtual-list";

interface ListHandle {
  readonly count: number;
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

const tabStops = (row: Element): HTMLElement[] =>
  [...row.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => element.tabIndex >= 0 && element.closest("[hidden], [inert]") === null,
  );

const scrollParent = (element: HTMLElement | null): HTMLElement | null => {
  for (let at = element?.parentElement ?? null; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY === "auto" || overflowY === "scroll") return at;
  }
  return null;
};

const offsetIn = (list: HTMLElement, scroller: HTMLElement): number | undefined => {
  if (list.getClientRects().length === 0) return undefined;
  return (
    list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
};

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
  if (!instance.itemSizeCache.has(key) && instance.measurementsCache[index]?.size === size) {
    instance.itemSizeCache.set(key, size);
  }
  return size;
}

function typicalSize(
  instance: Virtualizer<HTMLElement, HTMLElement> | undefined,
): number | undefined {
  if (instance === undefined || instance.itemSizeCache.size === 0) return undefined;
  let sum = 0;
  for (const size of instance.itemSizeCache.values()) sum += size;
  return sum / instance.itemSizeCache.size;
}

function typicalByClass<T>(
  instance: Virtualizer<HTMLElement, HTMLElement> | undefined,
  items: readonly T[],
  rowKey: (item: T) => string,
  sizeClass: ((item: T) => string) | undefined,
): ReadonlyMap<string, number> | undefined {
  if (sizeClass === undefined || instance === undefined || instance.itemSizeCache.size === 0) {
    return undefined;
  }
  const sums = new Map<string, { sum: number; count: number }>();
  for (const item of items) {
    const size = instance.itemSizeCache.get(rowKey(item));
    if (size === undefined) continue;
    const kind = sizeClass(item);
    const at = sums.get(kind) ?? { sum: 0, count: 0 };
    sums.set(kind, { sum: at.sum + size, count: at.count + 1 });
  }
  return new Map([...sums].map(([kind, { sum, count }]) => [kind, sum / count]));
}

export function VirtualRows<T>({
  items,
  rowKey,
  estimate,
  sizeClass,
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
  /**
   * The kind of row an item draws, when the kinds differ in height (a one-line or a two-line
   * row): a row not drawn yet is guessed from the drawn rows of its own kind.
   */
  sizeClass?: (item: T) => string;
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
  "use no memo";
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
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
  const offsetChanged = useRef<(offset: number, isScrolling: boolean) => void>(undefined);
  const scrollWritten = useRef<() => void>(undefined);
  const typical = typicalSize(virtualizerRef.current) ?? estimate;
  const byClass = typicalByClass(virtualizerRef.current, items, rowKey, sizeClass);
  // oxlint-disable-next-line react/incompatible-library -- opted out of memoization above
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: items.length,
    getScrollElement: () => (scroller.current ??= scrollParent(root.current)),
    observeElementOffset: (instance, changed) => {
      offsetChanged.current = changed;
      return observeElementOffset(instance, changed);
    },
    scrollToFn: (offset, options, instance) => {
      elementScroll(offset, options, instance);
      scrollWritten.current?.();
    },
    estimateSize: (index) => {
      const item = items[index];
      if (byClass === undefined || sizeClass === undefined || item === undefined) return typical;
      return byClass.get(sizeClass(item)) ?? typical;
    },
    getItemKey: (index) => (items[index] === undefined ? index : rowKey(items[index])),
    gap,
    overscan,
    scrollMargin: margin,
    rangeExtractor,
    measureElement: measureShown,
  });
  virtualizerRef.current = virtualizer;

  useLayoutEffect(() => {
    const list = root.current;
    const parent = (scroller.current ??= scrollParent(list));
    if (list === null || parent === null) return;
    let seenOffset: number | undefined;
    let seenScroll = parent.scrollTop;
    scrollWritten.current = () => {
      seenScroll = parent.scrollTop;
    };
    const measure = () => {
      const offset = offsetIn(list, parent);
      if (offset === undefined) return;
      const seen = seenOffset === undefined ? undefined : seenOffset - seenScroll;
      const at = offset - parent.scrollTop;
      if (seen !== undefined && seen < 0 && Math.abs(at - seen) >= 0.5) {
        parent.scrollTop += at - seen;
        offsetChanged.current?.(parent.scrollTop, virtualizer.isScrolling);
      }
      seenScroll = parent.scrollTop;
      seenOffset = offset;
      setMargin((was) => (Math.abs(was - offset) < 0.5 ? was : offset));
    };
    const scrolled = () => {
      if (parent.scrollTop === seenScroll) return;
      seenScroll = parent.scrollTop;
      const offset = offsetIn(list, parent);
      if (offset !== undefined) seenOffset = offset;
    };
    measure();
    parent.addEventListener("scroll", scrolled, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => {
        scrollWritten.current = undefined;
        parent.removeEventListener("scroll", scrolled);
      };
    }
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(parent);
    for (const child of parent.children) observer.observe(child);
    const added = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node instanceof Element) observer.observe(node);
      }
      measure();
    });
    added.observe(parent, { childList: true });
    return () => {
      scrollWritten.current = undefined;
      observer.disconnect();
      added.disconnect();
      parent.removeEventListener("scroll", scrolled);
    };
  }, [virtualizer]);

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
    await painted();
  }
  return null;
}

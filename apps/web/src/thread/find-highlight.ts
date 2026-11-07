import { useEffect, useRef } from "react";

/** The names `globals.css` styles with `::highlight()`. */
export const FIND_HIGHLIGHT = "gram-find";
export const FIND_CURRENT = "gram-find-current";

/** What find marks, by bar: two panes can each have one open. */
const marked = new Map<symbol, { all: Range[]; current: Range | undefined }>();

const supported = () =>
  typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";

function publish() {
  if (!supported()) return;
  const all = [...marked.values()].flatMap((m) => m.all);
  const current = [...marked.values()].flatMap((m) => (m.current ? [m.current] : []));
  if (all.length === 0) CSS.highlights.delete(FIND_HIGHLIGHT);
  else CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...all));
  if (current.length === 0) CSS.highlights.delete(FIND_CURRENT);
  else CSS.highlights.set(FIND_CURRENT, new Highlight(...current));
}

/** Each case-blind occurrence of `needle` in `root`'s text, in document order. */
export function textRanges(root: Node, needle: string): Range[] {
  const ranges: Range[] = [];
  if (needle === "") return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.nodeValue ?? "").toLowerCase();
    let at = text.indexOf(needle);
    while (at !== -1) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

const rowOf = (scroller: ParentNode, messageId: string) =>
  scroller.querySelector<HTMLElement>(`[data-message-id=${JSON.stringify(messageId)}]`);

/**
 * Opens the closed card of `toolCallId`, or first the closed group it is in, one step a call. True
 * once its card is open or there is nothing more to open.
 */
export function openToolCard(row: ParentNode, toolCallId: string): boolean {
  const id = JSON.stringify(toolCallId);
  const card = row.querySelector<HTMLElement>(`[data-tool-call-id=${id}]`);
  if (card) {
    const trigger = card.querySelector<HTMLElement>("button");
    if (trigger && !trigger.hasAttribute("data-panel-open")) {
      trigger.click();
      return false;
    }
    return true;
  }
  const toggle = row.querySelector<HTMLElement>(
    `[data-tool-call-ids~=${id}] > button[aria-expanded="false"]`,
  );
  if (toggle) {
    toggle.click();
    return false;
  }
  return true;
}

export interface FindTarget {
  readonly key: string;
  readonly messageId: string;
  readonly occurrence: number;
  readonly toolCallId?: string | undefined;
}

/**
 * Marks `query` in the transcript rows `scroller` has drawn, and the current match apart. Rows come
 * and go as the transcript scrolls, so it marks again whenever they change. The first time the
 * current match is drawn, its tool card is opened if it is in one, and it is scrolled into view.
 * `onUndrawn` asks for the current match's row when the transcript hasn't drawn it, or has drawn
 * it folded away.
 */
export function useFindHighlight(
  getScroller: () => HTMLElement | null | undefined,
  query: string,
  target: FindTarget | undefined,
  onUndrawn: (messageId: string) => void,
) {
  const id = useRef(Symbol("find"));
  const latest = useRef({ getScroller, onUndrawn });
  useEffect(() => {
    latest.current = { getScroller, onUndrawn };
  });

  useEffect(() => {
    const scroller = latest.current.getScroller();
    if (!scroller) return;
    const self = id.current;
    const needle = query.toLowerCase();
    // The current match is brought into view once, then left where the user scrolls it.
    let shown = target === undefined;
    let asked = false;
    let opening = 8;
    let frame = 0;

    const mark = () => {
      frame = 0;
      const all: Range[] = [];
      let current: Range | undefined;
      for (const row of scroller.querySelectorAll<HTMLElement>("[data-message-id]")) {
        const ranges = textRanges(row, needle);
        all.push(...ranges);
        if (target !== undefined && row.dataset.messageId === target.messageId) {
          current = ranges[Math.min(target.occurrence, ranges.length - 1)];
        }
      }
      marked.set(self, { all, current });
      publish();
      if (shown || target === undefined) return;
      const row = rowOf(scroller, target.messageId);
      if (!row) {
        if (!asked) latest.current.onUndrawn(target.messageId);
        asked = true;
        return;
      }
      // A match in a closed tool card: open it (and its group), then look again.
      if (target.toolCallId !== undefined && opening > 0 && !openToolCard(row, target.toolCallId)) {
        opening--;
        return;
      }
      // Drawn, but its words aren't: folded into a closed turn. Revealing it opens the fold.
      if (current === undefined && target.toolCallId === undefined && !asked) {
        latest.current.onUndrawn(target.messageId);
        asked = true;
        return;
      }
      const box = (current ?? row).getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (box.top < view.top || box.bottom > view.bottom) {
        scroller.scrollTop += box.top - view.top - view.height / 2 + box.height / 2;
      }
      shown = true;
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(mark);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    scroller.addEventListener("scroll", schedule, { passive: true });
    mark();
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
      marked.delete(self);
      publish();
    };
    // `target` by its key: a new search result with the same current match marks, but doesn't jump.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [query, target?.key]);
}

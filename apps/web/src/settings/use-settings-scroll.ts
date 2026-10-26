import { useLocation, useRouter, type ParsedLocation } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long a highlighted setting stays marked when nothing is clicked or typed first. */
const SPOTLIGHT_MS = 6000;

/** Frames to wait for a page, or a highlighted setting that renders after its data loads. */
const SETTLE_FRAMES = 30;

/** A history entry's identity, the same when Back or Forward returns to it. */
const entryOf = (location: ParsedLocation) => location.state.key ?? location.href;

/**
 * Where the Settings page scroll sits: a tab opens at the top, Back and Forward return to where that
 * entry was left, a search starts from the top and clearing it goes back, and `?highlight=` scrolls
 * to what it marks on first arrival. Returns
 * the words to spotlight, until a click, a key or `SPOTLIGHT_MS` ends it.
 */
export function useSettingsScroll({
  page,
  highlight,
  searching,
}: {
  page: string | undefined;
  highlight: string | undefined;
  searching: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const entry = useLocation({ select: entryOf });
  const positions = useRef(new Map<string, number>());
  /** The entry the scroll was last laid out for, whose position it holds. */
  const shown = useRef<string>(undefined);
  /** Where the page was when a search took over the view, to go back to when it's cleared. */
  const beforeSearch = useRef<{ entry: string; top: number }>(undefined);
  /** Entries whose highlight has had its turn: it ended, or the entry was left and so is a revisit. */
  const [ended, setEnded] = useState<ReadonlySet<string>>(() => new Set());
  const endSpotlight = (of: string) =>
    setEnded((done) => (done.has(of) ? done : new Set(done).add(of)));

  // Read before the router renders anything of the next location: by the time a scroll event
  // reports it, the shorter page has already clamped the old one's position. Filed under `shown`,
  // not the event's `fromLocation`, which is the last location to finish loading: on a slow machine
  // a Back pressed before the page it leaves had finished named the page before, and overwrote that
  // page's position with this one's.
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", () => {
        const scroller = scrollRef.current;
        const from = shown.current;
        if (from === undefined || !scroller) return;
        positions.current.set(
          from,
          beforeSearch.current?.entry === from ? beforeSearch.current.top : scroller.scrollTop,
        );
        endSpotlight(from);
      }),
    [router],
  );
  const spotlight = highlight !== undefined && !ended.has(entry) ? highlight : undefined;

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    shown.current = entry;
    if (page === undefined) return;
    // A revisit returns to where the entry was left; only a first arrival jumps to the highlight.
    const left = positions.current.get(entry);
    const jump = highlight !== undefined && left === undefined;
    const saved = left ?? 0;
    scroller.scrollTop = saved;
    // The page itself can render a frame after this layout sees the new location, and until it
    // does the old one's height clamps the scroll, so both are retried until they land.
    let frames = 0;
    let frame = requestAnimationFrame(function settle() {
      if (!jump) {
        scroller.scrollTop = saved;
        if (scroller.scrollTop === saved) return;
      } else {
        const target = scroller.querySelector("[data-setting-spotlight]");
        // Centred when it fits, else from its top, so a tall group keeps its heading in view.
        const tall = target && target.getBoundingClientRect().height > scroller.clientHeight / 2;
        if (target) return target.scrollIntoView({ block: tall ? "start" : "center" });
      }
      if (++frames < SETTLE_FRAMES) frame = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(frame);
    // Only a new history entry moves the scroll; `highlight` is read from the entry it arrived with.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, page]);

  const wasSearching = useRef(searching);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (wasSearching.current === searching || !scroller) return;
    wasSearching.current = searching;
    if (searching) {
      scroller.scrollTop = 0;
      return;
    }
    // Cleared on the same page: back to where it was. A tab picked from the list scrolls itself.
    if (beforeSearch.current?.entry === entry) scroller.scrollTop = beforeSearch.current.top;
    beforeSearch.current = undefined;
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  useEffect(() => {
    if (spotlight === undefined) return;
    // The key that brought the page, such as Enter in the search box, can still be on its way up
    // when this runs; only a click or key after the page arrived ends the spotlight.
    const since = performance.now();
    const end = (event?: Event) => {
      if (event !== undefined && event.timeStamp < since) return;
      endSpotlight(entry);
    };
    const timer = setTimeout(end, SPOTLIGHT_MS);
    window.addEventListener("pointerdown", end);
    window.addEventListener("keydown", end);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerdown", end);
      window.removeEventListener("keydown", end);
    };
  }, [spotlight, entry]);

  /** Call as a search starts, before the results replace the page and clamp its scroll. */
  const holdScroll = () => {
    if (scrollRef.current) beforeSearch.current = { entry, top: scrollRef.current.scrollTop };
  };

  return { scrollRef, spotlight, holdScroll };
}

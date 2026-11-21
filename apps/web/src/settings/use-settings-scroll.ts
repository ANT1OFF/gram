import { useLocation, useRouter, type ParsedLocation } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

const SPOTLIGHT_MS = 6000;

const SETTLE_FRAMES = 30;

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
  const shown = useRef<string>(undefined);
  const beforeSearch = useRef<{ entry: string; top: number }>(undefined);
  const [ended, setEnded] = useState<ReadonlySet<string>>(() => new Set());
  const endSpotlight = (of: string) =>
    setEnded((done) => (done.has(of) ? done : new Set(done).add(of)));

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
    const left = positions.current.get(entry);
    const jump = highlight !== undefined && left === undefined;
    const saved = left ?? 0;
    scroller.scrollTop = saved;
    let frames = 0;
    let frame = requestAnimationFrame(function settle() {
      if (!jump) {
        scroller.scrollTop = saved;
        if (scroller.scrollTop === saved) return;
      } else {
        const target = scroller.querySelector("[data-setting-spotlight]");
        const tall = target && target.getBoundingClientRect().height > scroller.clientHeight / 2;
        if (target) return target.scrollIntoView({ block: tall ? "start" : "center" });
      }
      if (++frames < SETTLE_FRAMES) frame = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(frame);
    // oxlint-disable-next-line react/exhaustive-deps -- only a new history entry moves the scroll; `highlight` comes with the entry
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
    if (beforeSearch.current?.entry === entry) scroller.scrollTop = beforeSearch.current.top;
    beforeSearch.current = undefined;
    // oxlint-disable-next-line react/exhaustive-deps -- runs when a search starts or ends; `entry` is read as it is then
  }, [searching]);

  useEffect(() => {
    if (spotlight === undefined) return;
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

  const holdScroll = () => {
    if (scrollRef.current) beforeSearch.current = { entry, top: scrollRef.current.scrollTop };
  };

  return { scrollRef, spotlight, holdScroll };
}

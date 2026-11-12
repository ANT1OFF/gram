import { useEffect, useRef, type RefObject } from "react";

/** How far a list fades out at an edge with more of it past that edge, at most. */
const FADE = 20;

/**
 * A scrolling list's edges, told to its own style: `--fade-top` and `--fade-bottom` are the fade's
 * length while rows lie past that edge, shrinking to 0 at the list's end, for a mask to read. It follows the
 * list's scrolling and its own and its rows' changes of size. Off, it sets nothing.
 */
export function useScrollFade(on: boolean): RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = ref.current;
    if (!on || list === null) return;
    const read = () => {
      const below = list.scrollHeight - list.clientHeight - list.scrollTop;
      // No longer than what is past the edge: the list's last row is whole at its end.
      list.style.setProperty("--fade-top", `${Math.min(FADE, Math.max(0, list.scrollTop))}px`);
      list.style.setProperty("--fade-bottom", `${Math.min(FADE, Math.max(0, below))}px`);
    };
    read();
    list.addEventListener("scroll", read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(list);
    for (const child of list.children) observer.observe(child);
    return () => {
      list.removeEventListener("scroll", read);
      observer.disconnect();
      list.style.removeProperty("--fade-top");
      list.style.removeProperty("--fade-bottom");
    };
  }, [on]);
  return ref;
}

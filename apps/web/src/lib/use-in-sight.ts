import { useState, type RefObject } from "react";
import { useSubscription } from "@/lib/effects";

/**
 * Whether anybody can see `anchor`, kept current: false while the window is in the background or
 * the element is under `display: none`, which is how a hidden tab or pane stays mounted. An engine
 * without `IntersectionObserver` counts as seen.
 */
export function useInSight(anchor: RefObject<Element | null>): boolean {
  const [shown, setShown] = useState(true);
  const [foreground, setForeground] = useState(() => !document.hidden);
  useSubscription(() => {
    const onVisibility = () => setForeground(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    const element = anchor.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return () => document.removeEventListener("visibilitychange", onVisibility);
    }
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) setShown(last.isIntersecting);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [anchor]);
  return shown && foreground;
}

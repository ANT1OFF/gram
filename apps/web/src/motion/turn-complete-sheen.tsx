import type { ThreadStatus } from "@gram/contracts";
import { useEffect, useRef, type ReactNode } from "react";

import type { ResolvedMotion } from "@/theme/theme";

import { outOfSight } from "./count-up";
import { useMotionLevel } from "./hooks";

import "./turn-complete-sheen.css";

/**
 * One border pass, discarded if its surface leaves view. Reduced fades the border without moving;
 * Off creates nothing. The overlay is decorative and never intercepts a pointer or keyboard event.
 */
export function playTurnCompleteSheen(surface: HTMLElement, level: ResolvedMotion): () => void {
  const bounds = surface.getBoundingClientRect();
  if (
    level === "off" ||
    outOfSight(surface) ||
    bounds.bottom <= 0 ||
    bounds.top >= window.innerHeight ||
    bounds.right <= 0 ||
    bounds.left >= window.innerWidth
  ) {
    return () => {};
  }

  const border = document.createElement("span");
  border.className = "gram-turn-complete-sheen";
  border.dataset["testid"] = "turn-complete-sheen";
  border.setAttribute("aria-hidden", "true");
  const light = document.createElement("span");
  light.className = level === "full" ? "gram-turn-complete-sweep" : "gram-turn-complete-fade";
  border.append(light);
  surface.append(border);

  const animation = light.animate(
    level === "full"
      ? [
          { transform: "translateX(-100%)", opacity: 0 },
          { opacity: 0.65, offset: 0.25 },
          { opacity: 0.65, offset: 0.75 },
          { transform: "translateX(300%)", opacity: 0 },
        ]
      : [{ opacity: 0 }, { opacity: 0.5 }, { opacity: 0 }],
    { duration: level === "full" ? 900 : 450, easing: "ease-out", iterations: 1 },
  );

  const stop = () => {
    animation.cancel();
    border.remove();
    intersection.disconnect();
    visibility.disconnect();
    document.removeEventListener("visibilitychange", cancelHidden);
  };
  const cancelHidden = () => {
    if (outOfSight(surface)) stop();
  };
  const intersection = new IntersectionObserver((entries) => {
    if (entries.some((entry) => !entry.isIntersecting)) stop();
  });
  intersection.observe(surface);
  // Maximizing a grid pane hides its siblings without unmounting them. Observe the ancestors so
  // that hiding cancels this pass immediately, even before IntersectionObserver delivers a frame.
  const visibility = new MutationObserver(cancelHidden);
  for (let ancestor: HTMLElement | null = surface; ancestor; ancestor = ancestor.parentElement) {
    visibility.observe(ancestor, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });
  }
  document.addEventListener("visibilitychange", cancelHidden);
  animation.onfinish = stop;
  return stop;
}

/** Marks a live turn becoming idle, never initial history or a completion missed while hidden. */
export function TurnCompleteSheen({
  status,
  children,
}: {
  status: ThreadStatus;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const turnRan = useRef(false);
  const level = useMotionLevel();
  useEffect(() => {
    if (status === "running") {
      turnRan.current = true;
      return;
    }
    // Server-raised requests can interrupt idle threads without starting a turn.
    if (status === "needsApproval" || status === "needsInput") return;
    const completed = turnRan.current && status === "idle";
    turnRan.current = false;
    if (!completed) return;
    const surface = anchor.current?.querySelector<HTMLElement>('[data-surface="composer"]');
    if (surface) return playTurnCompleteSheen(surface, level);
  }, [status, level]);
  return (
    <div ref={anchor} className="shrink-0">
      {children}
    </div>
  );
}

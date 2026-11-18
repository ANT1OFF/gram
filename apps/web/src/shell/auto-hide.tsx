import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useMotionLevel } from "@/motion";
import { NAV_REGION, useNavigationStore } from "@/stores/navigation";

/** How long the pointer rests at the window's edge before the navigation slides back. */
export const REVEAL_AFTER_MS = 120;
/** How long the pointer may be off the navigation before it slides away. */
export const HIDE_AFTER_MS = 400;

/** What a menu, card, list or dialog opened from the navigation is drawn in, portalled out of it. */
const POPUP = '[data-surface="overlay"], [role="menu"], [role="listbox"], [role="dialog"]';

export type NavEdge = "left" | "top" | "bottom";

const HIDDEN: Record<NavEdge, string> = {
  left: "-translate-x-[calc(100%+--spacing(4))]",
  top: "-translate-y-[calc(100%+--spacing(4))]",
  bottom: "translate-y-[calc(100%+--spacing(4))]",
};

const PLACE: Record<NavEdge, string> = {
  left: "inset-y-0 left-0 flex",
  top: "inset-x-0 top-0 flex justify-center px-2 pt-2 pointer-events-none *:pointer-events-auto",
  bottom:
    "inset-x-0 bottom-0 flex justify-center px-2 pb-2 pointer-events-none *:pointer-events-auto",
};

const ZONE: Record<NavEdge, string> = {
  left: "inset-y-0 left-0 w-1.5",
  top: "inset-x-0 top-0 h-1.5",
  bottom: "inset-x-0 bottom-0 h-1.5",
};

/**
 * Holds the main navigation out of view at its edge of the window until it is wanted: the pointer
 * resting at that edge, the keyboard's focus moving into it (it stays in the tab order and the
 * accessibility tree while out of view), or ⌘B. Leaving it with both pointer and focus, Escape, or
 * ⌘B again slides it away. Reduced motion shows and hides it without the slide.
 */
export function AutoHide({
  edge,
  width,
  inert = false,
  children,
}: {
  edge: NavEdge;
  /** The navigation's width at the left edge. */
  width?: number;
  inert?: boolean;
  children: ReactNode;
}) {
  const revealed = useNavigationStore((s) => s.revealed);
  const hideTick = useNavigationStore((s) => s.hideTick);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const shown = revealed || hover || focus;
  const box = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const slides = useMotionLevel() === "full";

  useEffect(() => useNavigationStore.getState().setShown(shown), [shown]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      useNavigationStore.getState().setShown(false);
    },
    [],
  );

  // ⌘B or Escape hid it: whatever held it goes, and the focus leaves it for the page.
  const [tick, setTick] = useState(hideTick);
  if (tick !== hideTick) {
    setTick(hideTick);
    setHover(false);
    setFocus(false);
  }
  useEffect(() => {
    if (hideTick === 0) return;
    clearTimeout(timer.current);
    if (box.current?.contains(document.activeElement)) {
      document.querySelector<HTMLElement>("#content")?.focus();
    }
  }, [hideTick]);

  const hideLater = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(function check() {
      // A menu opened from it is still its: it stays until that closes.
      if (document.querySelector(POPUP) !== null) {
        timer.current = setTimeout(check, HIDE_AFTER_MS);
        return;
      }
      setHover(false);
    }, HIDE_AFTER_MS);
  };

  return (
    <>
      <div
        aria-hidden
        data-testid="nav-edge"
        data-edge={edge}
        className={cn("fixed z-40", ZONE[edge])}
        onPointerEnter={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setHover(true), REVEAL_AFTER_MS);
        }}
        onPointerLeave={() => {
          if (!hover) clearTimeout(timer.current);
        }}
      />
      <div
        ref={box}
        data-testid="nav-auto-hide"
        inert={inert}
        {...{ [NAV_REGION]: "auto-hide" }}
        data-edge={edge}
        data-shown={shown ? "" : undefined}
        className={cn(
          "fixed z-40",
          PLACE[edge],
          slides && "transition-[translate] duration-(--dur-move-base) ease-(--ease-out)",
          !shown && HIDDEN[edge],
          edge === "left" && shown && "shadow-overlay",
        )}
        style={edge === "left" ? { width } : undefined}
        onPointerEnter={() => {
          clearTimeout(timer.current);
          setHover(true);
        }}
        onPointerLeave={hideLater}
        // From the keyboard only: a click's focus is the click's, which goes somewhere itself.
        onFocus={(event) => {
          if (event.target instanceof Element && event.target.matches(":focus-visible"))
            setFocus(true);
        }}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (next instanceof Node && box.current?.contains(next)) return;
          if (next instanceof Element && next.closest(POPUP) !== null) return;
          setFocus(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented) return;
          event.preventDefault();
          useNavigationStore.getState().hide();
        }}
      >
        {children}
      </div>
    </>
  );
}

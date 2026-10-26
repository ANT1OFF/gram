import { AnimatePresence, useIsPresent, type HTMLMotionProps } from "motion/react";
import * as m from "motion/react-m";
import type { KeyboardEvent, ReactNode } from "react";

import { useLookMotion, useMotionLevel } from "./hooks";
import { toEase } from "./transitions";

/**
 * A list whose items arrive and leave rather than appear and vanish: a request card answered, a
 * queued message sent, a toast dismissed. What is there when the list mounts stays still.
 */
export function PresenceList({ children }: { children: ReactNode }) {
  return <AnimatePresence initial={false}>{children}</AnimatePresence>;
}

interface PresenceItemProps {
  /** `li` inside a list element; a `div` otherwise. */
  as?: "div" | "li";
  /** Where it arrives from: below for what lands in a column, the right for what slides in beside. */
  from?: "below" | "right";
  /** Glides to its new place when the list is reordered around it. */
  glide?: boolean;
  className?: string;
  children: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  [data: `data-${string}`]: string | boolean | undefined;
}

/**
 * One item of a `PresenceList`. It fades up into place, and leaves by fading while its box folds to
 * nothing, so what is under it closes up instead of jumping. A leaving item is inert: a click meant
 * for it can't land, and one meant for its successor can't hit it. Reduced only fades, and then the
 * space closes at once; Off does neither.
 */
export function PresenceItem({
  as = "div",
  from = "below",
  glide = false,
  ...props
}: PresenceItemProps) {
  const level = useMotionLevel();
  const look = useLookMotion();
  const present = useIsPresent();
  const full = level === "full";
  const offset = from === "below" ? { y: 6 } : { x: 16 };
  const rest = from === "below" ? { y: 0 } : { x: 0 };
  const motion: HTMLMotionProps<"div"> & HTMLMotionProps<"li"> =
    level === "off"
      ? {}
      : {
          initial: { opacity: 0, ...(full ? offset : {}) },
          animate: { opacity: 1, ...(full ? rest : {}) },
          exit: {
            opacity: 0,
            ...(full
              ? { height: 0, marginTop: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 }
              : {}),
          },
          transition: {
            type: "tween",
            duration: look.durations.base / 1000,
            ease: toEase(look.easing.out),
          },
        };
  // Clipped only while it folds: at rest its children's focus rings and shadows may overhang it.
  const shared = {
    ...props,
    ...motion,
    ...(glide ? { layout: "position" as const } : {}),
    inert: !present,
    style: present ? {} : { overflow: "clip" },
  };
  return as === "li" ? <m.li {...shared} /> : <m.div {...shared} />;
}

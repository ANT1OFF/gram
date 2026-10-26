import {
  AnimatePresence,
  useIsPresent,
  type TargetAndTransition,
  type Transition,
} from "motion/react";
import * as m from "motion/react-m";
import type { ReactNode } from "react";

import type { ResolvedMotion } from "@/theme/theme";

import { useMotionLevel, usePresetTransition } from "./hooks";

/**
 * How a slot comes and goes under each motion setting. Full opens it to its width as it fades in and
 * settles from small, so what is beside it slides over; Reduced only fades it, its width changing at
 * once; Off does both at once. `gap` is the row's gap in pixels, folded away with the slot.
 */
export function slotMotion(
  level: ResolvedMotion,
  gap: number,
  preset: Transition,
): { closed: TargetAndTransition; transition: Transition } {
  const closed = { opacity: 0, width: 0, scale: level === "full" ? 0.6 : 1, marginInlineEnd: -gap };
  if (level === "full") return { closed, transition: preset };
  const fade = level === "off" ? 0 : 0.12;
  return {
    closed,
    transition: { duration: fade, width: { duration: 0 }, marginInlineEnd: { duration: 0 } },
  };
}

/**
 * An inline control that comes and goes beside others, such as Stop beside Send: it arrives and
 * leaves by `slotMotion` rather than popping in and shoving its neighbours over. What is there at
 * mount is simply there.
 */
export function SlotPresence({
  shown,
  gap = 0,
  children,
}: {
  shown: boolean;
  gap?: number;
  children: ReactNode;
}) {
  const level = useMotionLevel();
  const { closed, transition } = slotMotion(level, gap, usePresetTransition("snappy"));
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <Slot key="slot" closed={closed} transition={transition}>
          {children}
        </Slot>
      )}
    </AnimatePresence>
  );
}

/**
 * The slot itself, inert while it leaves: a press or Tab meant for what is beside it must not land
 * on a control that is already going, which still covers its old place as it fades.
 */
function Slot({
  closed,
  transition,
  children,
}: {
  closed: TargetAndTransition;
  transition: Transition;
  children: ReactNode;
}) {
  const present = useIsPresent();
  return (
    <m.span
      className="inline-flex shrink-0 justify-center"
      initial={closed}
      animate={{ opacity: 1, width: "auto", scale: 1, marginInlineEnd: 0 }}
      exit={closed}
      transition={transition}
      inert={!present}
    >
      {children}
    </m.span>
  );
}

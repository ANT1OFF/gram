import { animate } from "motion/react";
import { useLayoutEffect, useRef, type HTMLAttributes, type Ref } from "react";

import { useMotionLevel, usePresetTransition } from "./hooks";

/** Where a slab was on screen, in viewport pixels, for the one replacing it to move in from. */
export interface SlabOrigin {
  readonly x: number;
  readonly y: number;
}

/**
 * A composer-shaped box that can move between screens: the `/new` hero's prompt box glides into
 * the new thread's composer on send. Given `from`, it starts there and moves to where it lays out,
 * by transform, with the look's gentle preset; only at Full motion, since Reduced and Off don't
 * move things. `onArrived` runs once it is in place, straight away when it doesn't move.
 */
export function SharedSlab({
  ref,
  from,
  onArrived,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement> | undefined;
  from?: SlabOrigin | undefined;
  onArrived?: (() => void) | undefined;
}) {
  const level = useMotionLevel();
  const gentle = usePresetTransition("gentle");
  const local = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = local.current;
    if (from === undefined || el === null) return;
    if (level !== "full") {
      onArrived?.();
      return;
    }
    const box = el.getBoundingClientRect();
    const controls = animate(el, { x: [from.x - box.left, 0], y: [from.y - box.top, 0] }, gentle);
    void controls.then(() => onArrived?.());
    return () => {
      controls.stop();
      el.style.transform = "";
    };
    // Once per origin: the move starts where the old slab was, not again on each render.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies, react-hooks/exhaustive-deps -- see above
  }, [from]);

  return (
    <div
      ref={(el) => {
        local.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      {...props}
    />
  );
}

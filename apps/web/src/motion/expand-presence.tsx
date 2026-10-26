import { useEffect, useReducer, type ReactNode } from "react";

import { Expand } from "./expand";
import { useLookMotion, useMotionLevel } from "./hooks";

export interface ExpandPresenceState {
  /** Whether the children are in the DOM at all. */
  readonly mounted: boolean;
  /** Whether the box is at full height; false for the frame after mounting and while closing. */
  readonly shown: boolean;
}

export type ExpandPresenceEvent =
  | { readonly type: "open" }
  | { readonly type: "frame" }
  | { readonly type: "close"; readonly animated: boolean }
  | { readonly type: "closed" };

/**
 * Opening mounts the children collapsed and unfolds them a frame later, so there is a height to
 * animate from; closing folds first and unmounts once that is over, or at once with nothing to wait
 * for. Reopening mid-close keeps what is mounted.
 */
export const expandPresence = (
  state: ExpandPresenceState,
  event: ExpandPresenceEvent,
): ExpandPresenceState => {
  switch (event.type) {
    case "open":
      return state.mounted ? { mounted: true, shown: true } : { mounted: true, shown: false };
    case "frame":
      return state.mounted ? { mounted: true, shown: true } : state;
    case "close":
      return { mounted: event.animated && state.mounted, shown: false };
    case "closed":
      return state.shown ? state : { mounted: false, shown: false };
  }
};

/**
 * `Expand` for content too heavy to keep around while folded, such as a sidebar group of a hundred
 * parked threads: the children exist only while open or folding away. Open at mount is simply open.
 * Under Reduced and Off nothing folds, so closing unmounts at once.
 */
export function ExpandPresence({
  open,
  id,
  className,
  children,
}: {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  const animated = useMotionLevel() === "full";
  // The fold is `--dur-move-base`; a little over it, so the unmount never cuts the last frames.
  const foldMs = useLookMotion().durations.base + 60;
  const [state, dispatch] = useReducer(expandPresence, { mounted: open, shown: open });

  useEffect(() => {
    if (open) {
      dispatch({ type: "open" });
      const frame = requestAnimationFrame(() => dispatch({ type: "frame" }));
      return () => cancelAnimationFrame(frame);
    }
    dispatch({ type: "close", animated });
    const timer = setTimeout(() => dispatch({ type: "closed" }), foldMs);
    return () => clearTimeout(timer);
  }, [open, animated, foldMs]);

  // `open` wins over a state that hasn't caught up, so the first render after opening already mounts.
  if (!state.mounted && !open) return null;
  return (
    <Expand
      open={open && state.shown}
      {...(id === undefined ? {} : { id })}
      {...(className === undefined ? {} : { className })}
    >
      {children}
    </Expand>
  );
}

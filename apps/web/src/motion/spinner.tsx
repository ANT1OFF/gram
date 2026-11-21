import { createLucideIcon, type LucideIcon } from "lucide-react";
import { forwardRef, useCallback } from "react";

import { spin } from "./spin";

const Arc = createLucideIcon({
  name: "spinner",
  size: 24,
  node: [["path", { d: "M21.5 12a9.5 9.5 0 0 1-10.1 9.48", key: "arc" }]],
});

function spinningIcon(icon: LucideIcon, name: string): LucideIcon {
  const Icon = icon;
  const spinning: LucideIcon = forwardRef((props, ref) => {
    const turn = useCallback(
      (element: SVGSVGElement | null) => {
        const stop = spin(element);
        if (typeof ref === "function") ref(element);
        else if (ref !== null) ref.current = element;
        return () => {
          stop?.();
          if (typeof ref === "function") ref(null);
          else if (ref !== null) ref.current = null;
        };
      },
      [ref],
    );
    return <Icon {...props} ref={turn} />;
  });
  spinning.displayName = name;
  return spinning;
}

/**
 * The one working and running glyph, a single arc on the shared clock. Draw it only for what works;
 * it reads the same as a running tool line in the feed.
 */
export const Spinner: LucideIcon = spinningIcon(Arc, "Spinner");

const Ring = createLucideIcon({
  name: "ring-spinner",
  size: 24,
  node: [
    [
      "circle",
      {
        cx: "12",
        cy: "12",
        r: "10",
        opacity: "0.25",
        strokeWidth: "1.5",
        vectorEffect: "non-scaling-stroke",
        key: "track",
      },
    ],
    [
      "path",
      {
        d: "M12 2a10 10 0 0 1 10 10",
        strokeWidth: "1.5",
        vectorEffect: "non-scaling-stroke",
        key: "arc",
      },
    ],
  ],
});

/**
 * The running ring: a faint ring with one arc, turning on the shared clock while it is mounted and
 * standing still under Reduced or Off motion. Only for a turn under way (the ring round Stop), never
 * for a wait: a PR can wait on CI for an hour, and a turning mark keeps the renderer drawing.
 */
export const RingSpinner: LucideIcon = spinningIcon(Ring, "RingSpinner");

const Hollow = createLucideIcon({
  name: "pending-ring",
  size: 24,
  node: [
    [
      "circle",
      {
        cx: "12",
        cy: "12",
        r: "9",
        strokeWidth: "1.5",
        vectorEffect: "non-scaling-stroke",
        key: "ring",
      },
    ],
  ],
});

/**
 * The one pending mark for a PR: checks queued or running, a review bot's round under way. A still
 * hollow ring, the glyph-sized twin of `StatusDot`'s waiting dot (DESIGN.md: a hollow accent ring
 * waits on something outside it), at the running ring's thin stroke. It never moves, so a PR
 * waiting on CI costs the renderer nothing; the words beside it say queued or running.
 */
export const PendingRing: LucideIcon = Hollow;

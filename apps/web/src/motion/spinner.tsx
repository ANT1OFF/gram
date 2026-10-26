/*
 * The arc is the running phase of `StatusMark` (svg-spinners' `90-ring`, notice in
 * `THIRD-PARTY-NOTICES.md` beside this file): a quarter-and-a-bit of its ring, from three o'clock.
 */
import { createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react";
import { forwardRef, useCallback } from "react";

import { spin } from "./spin";

const Arc = createLucideIcon({
  name: "spinner",
  size: 24,
  node: [["path", { d: "M21.5 12a9.5 9.5 0 0 1-10.1 9.48", key: "arc" }]],
});

/**
 * `icon`, turning on the shared clock for as long as it is mounted, wherever it is drawn: a table of
 * icons can't forget to start it. Under Reduced or Off motion it holds still, so give it a shape
 * that reads still too. An icon like any other, so it takes lucide's props, sizes and ref.
 */
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

/*
 * A thin ring with a faint track and one quarter arc, for a PR's checks or review bot running. Its
 * strokes are 1.5 CSS px whatever size the glyph is drawn at, so it reads as thin at `size-3` as it
 * would at 24.
 */
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
        vectorEffect: "non-scaling-stroke",
        key: "track",
      },
    ],
    ["path", { d: "M12 2a10 10 0 0 1 10 10", vectorEffect: "non-scaling-stroke", key: "arc" }],
  ],
});

const ThinRing = forwardRef<SVGSVGElement, LucideProps>((props, ref) => (
  <Ring ref={ref} strokeWidth={1.5} {...props} />
));
ThinRing.displayName = "ThinRing";

/** The same ring, still: for a PR check that is queued and not yet running. */
export const RingGlyph: LucideIcon = ThinRing;

/**
 * The one PR-running glyph: a faint ring with one arc, turning on the shared clock while it is
 * mounted and standing still under Reduced or Off motion. Every PR state that is pending or running
 * draws it, so they all read alike.
 */
export const RingSpinner: LucideIcon = spinningIcon(ThinRing, "RingSpinner");

/*
 * The three bars are drawn after svg-spinners' `bars-scale-middle` (MIT, Copyright (c) Utkarsh
 * Verma; notice in `THIRD-PARTY-NOTICES.md` beside this file). Its SMIL loop isn't used: the bars
 * follow the microphone's loudness, a step at a time on the shared clock.
 */
import { cn } from "@/lib/utils";

import { onClock } from "./spin";

/** How tall each bar stands at rest, as a share of its full height; `motion.css` holds the same. */
const REST = [0.45, 0.7, 0.45] as const;
/** How much of the loudness each bar takes, so they don't move as one. */
const REACH = [0.7, 1, 0.55] as const;

/**
 * Where bar `index` stands for a loudness `level` (0–1), eased from where it stood, `previous`, so
 * speech moves the bars smoothly at the clock's 20 steps a second: half the way there each step.
 */
export const barScale = (index: 0 | 1 | 2, level: number, previous: number): number => {
  const target = Math.min(1, REST[index] + (1 - REST[index]) * REACH[index] * level);
  return previous + (target - previous) * 0.5;
};

const scaleOf = (bar: SVGElement): number => Number(bar.dataset["scale"] ?? Number.NaN);

/** The bars of one `LevelBars`, and where they read the loudness from. */
const sources = new WeakMap<SVGElement, () => number>();

const follow = onClock({
  step: (element) => {
    const level = sources.get(element as SVGElement)?.() ?? 0;
    element.querySelectorAll<SVGElement>(".gram-level-bar").forEach((bar, index) => {
      const i = index as 0 | 1 | 2;
      const previous = scaleOf(bar);
      const next = barScale(i, level, Number.isNaN(previous) ? REST[i] : previous);
      bar.dataset["scale"] = String(next);
      bar.style.scale = `1 ${next}`;
    });
  },
  rest: (element) => {
    element.querySelectorAll<SVGElement>(".gram-level-bar").forEach((bar) => {
      delete bar.dataset["scale"];
      bar.style.scale = "";
    });
  },
});

/**
 * Three bars that rise and fall with how loud the microphone is, for a mic button while it
 * listens: proof it hears you, not decoration, so they stand still in silence. On the shared clock,
 * so they move only while on screen, the window shown and motion Full; otherwise, and under Reduced
 * and Off, they stand at rest, still reading as "listening" by their shape. `level` is read each
 * step, so the loudness never re-renders anything.
 */
export function LevelBars({ level, className }: { level: () => number; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="currentColor"
      data-testid="level-bars"
      ref={(element) => {
        if (element === null) return;
        sources.set(element, level);
        const detach = follow(element);
        return () => {
          detach?.();
          sources.delete(element);
        };
      }}
      className={cn("size-4", className)}
    >
      {[3.5, 10, 16.5].map((x) => (
        <rect key={x} className="gram-level-bar" x={x} y={3} width={4} height={18} rx={2} />
      ))}
    </svg>
  );
}

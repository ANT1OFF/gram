import { clockPhase, onClock } from "./spin";

/** How long the light takes to cross the border once. */
const SWEEP_MS = 2800;

const sweep = onClock({
  step: (element, now) => {
    element.style.opacity = "1";
    element.style.translate = `${-100 + 500 * clockPhase(now, SWEEP_MS)}% 0`;
  },
  rest: (element) => {
    element.style.opacity = "";
    element.style.translate = "";
  },
});

/**
 * The composer's border while the agent works: a faint accent tint, which is all a pane out of
 * focus, Reduced and Off show, and a soft light crossing it while `moving`. Decorative, and never in
 * the way of a pointer or key.
 */
export function RunningEdge({ moving }: { moving: boolean }) {
  return (
    <span aria-hidden data-testid="running-edge" className="gram-running-edge">
      <span className="gram-running-tint" />
      <span ref={moving ? sweep : undefined} className="gram-running-light" />
    </span>
  );
}

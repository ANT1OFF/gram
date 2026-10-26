/** How long a spinner takes to turn once, and how often it moves. */
const SPIN_MS = 1000;
const SPIN_STEP_MS = 50;

/** Where every spinner stands at `now`: one angle for all of them, a step at a time. */
export const spinAngle = (now: number): number =>
  ((Math.floor(now / SPIN_STEP_MS) * SPIN_STEP_MS) % SPIN_MS) * (360 / SPIN_MS);

type Spinner = HTMLElement | SVGElement;

/** How far through a `periodMs` cycle the clock stands at `now`, from 0 up to 1, a step at a time. */
export const clockPhase = (now: number, periodMs: number): number =>
  ((Math.floor(now / SPIN_STEP_MS) * SPIN_STEP_MS) % periodMs) / periodMs;

/** What an element on the clock does at each step, and how it is put back when the clock stops. */
interface Clocked {
  readonly step: (element: Spinner, now: number) => void;
  readonly rest: (element: Spinner) => void;
}

/** The elements attached, and those of them on screen, which are all that move. */
const attached = new Map<Spinner, Clocked>();
const onScreen = new Set<Spinner>();
let observer: IntersectionObserver | undefined;
let timer: ReturnType<typeof setInterval> | undefined;

const turn = () => {
  const now = performance.now();
  for (const element of onScreen) attached.get(element)?.step(element, now);
};

/** Runs the one clock while anything on it is on screen, the window shown and motion Full. */
const sync = () => {
  const run =
    onScreen.size > 0 &&
    !document.hidden &&
    document.documentElement.getAttribute("data-motion") === "full";
  if (run && timer === undefined) {
    turn();
    timer = setInterval(turn, SPIN_STEP_MS);
  } else if (!run && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
    for (const [element, clocked] of attached) clocked.rest(element);
  }
};

/**
 * Off screen covers a row scrolled out of the sidebar and a hidden pane: under `display: none` an
 * element stops intersecting. An engine without `IntersectionObserver` counts every spinner as seen.
 */
const watch = (element: Spinner) => {
  if (typeof IntersectionObserver === "undefined") {
    onScreen.add(element);
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target as Spinner;
      if (entry.isIntersecting && attached.has(target)) onScreen.add(target);
      else onScreen.delete(target);
    }
    sync();
  });
  observer.observe(element);
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", sync);
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(sync).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
  }
}

/**
 * A ref that puts its element on the shared clock while attached, for motion that lasts as long as
 * a turn does. A CSS animation there keeps the compositor drawing 60 frames a second for as long as
 * anything works, about 13 % of a core in the desktop app for one spinner against under 1 % idle.
 * The clock steps 20 times a second instead (about 6 %), once for everything on it, and moves only
 * what is on screen, while the window is shown and motion is Full; otherwise `rest` holds.
 */
export const onClock =
  (clocked: Clocked) =>
  (element: Spinner | null): (() => void) | undefined => {
    if (element === null) return;
    attached.set(element, clocked);
    watch(element);
    sync();
    return () => {
      attached.delete(element);
      onScreen.delete(element);
      observer?.unobserve(element);
      clocked.rest(element);
      sync();
    };
  };

/**
 * A ref that turns its element while attached, for an icon that turns only while something runs, a
 * refresh's arrows: `ref={fetching ? spin : undefined}`. A `Spinner` turns on its own.
 */
export const spin = onClock({
  step: (element, now) => {
    element.style.rotate = `${spinAngle(now)}deg`;
  },
  rest: (element) => {
    element.style.rotate = "";
  },
});

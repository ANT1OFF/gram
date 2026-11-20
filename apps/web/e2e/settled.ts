import type { Locator, Page } from "@playwright/test";

// Waits on what a step leaves behind, for the places a spec used to sleep (`gram/no-sleep`): the
// frames a change is drawn in, and the end of the motion it starts. Neither is a time to wait.

/** After `count` animation frames: what a change was going to draw by then is drawn. */
export const frames = (page: Page, count = 2): Promise<void> =>
  page.evaluate(
    (left) =>
      new Promise<void>((resolve) => {
        const step = (n: number) => (n <= 0 ? resolve() : requestAnimationFrame(() => step(n - 1)));
        step(left);
      }),
    count,
  );

/** In the page: waits out the running finite animations under `root` (or the document), until none. */
const settle = async (root: Element | undefined) => {
  for (;;) {
    // A frame first, so motion a change has just started is running by the time it is looked for.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const running = (root?.getAnimations({ subtree: true }) ?? document.getAnimations()).filter(
      (animation) =>
        animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity,
    );
    if (running.length === 0) return;
    await Promise.allSettled(running.map((animation) => animation.finished));
  }
};

/**
 * Once every finite animation and transition running in the page, or in `within` and under it,
 * has ended, a frame on: the end state a fold, an opening popover or a resize transition makes.
 * Endless ones (spinners, a pulse) never end, so they are left out; so is one held paused.
 */
export const motionDone = async (target: Page | Locator): Promise<void> => {
  if ("mainFrame" in target) await target.evaluate(settle, undefined);
  else await target.evaluate(settle);
};

/**
 * Once what `target` matches has kept its boxes for `count` frames running: the end of motion
 * driven from script (a glide, a fold or a layout animation), which no CSS animation reports.
 */
export const steady = (target: Locator, count = 3): Promise<void> =>
  target.evaluateAll(async (elements, still) => {
    const boxes = () =>
      JSON.stringify(
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return [x, y, width, height];
        }),
      );
    let last = boxes();
    for (let unchanged = 0; unchanged < still;) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const now = boxes();
      unchanged = now === last ? unchanged + 1 : 0;
      last = now;
    }
  }, count);

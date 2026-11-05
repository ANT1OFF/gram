import { expect, type Locator } from "@playwright/test";

/** Board opens inside Swap's scale animation; visible does not mean its geometry has settled. */
export async function waitForBoardLayout(board: Locator): Promise<void> {
  await board.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      board.evaluate((root) => {
        for (
          let element: Element | null = root;
          element !== null;
          element = element.parentElement
        ) {
          if (
            element
              .getAnimations()
              .some(
                (animation) =>
                  animation.playState !== "finished" &&
                  animation.playState !== "idle" &&
                  animation.effect?.getComputedTiming().endTime !== Infinity,
              )
          )
            return false;
        }
        return true;
      }),
    )
    .toBe(true);
}

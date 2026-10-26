import type { Locator } from "@playwright/test";

/**
 * The terminal draws to a canvas, so there are no rows in the DOM to read or aim at. Its text comes
 * from the mirror kept for screen readers, which holds what is on screen, a line per row.
 */
export const terminalText = (terminal: Locator): Locator =>
  terminal.locator("[data-terminal-text]");

/**
 * The centre of where `target` is drawn, worked out from the cell grid: the canvas is exactly
 * `cols` × `rows` cells. `undefined` when the screen doesn't show `target`. Only right for text
 * with no wide characters before it on its row, which is all the mock shell prints.
 */
export async function cellCenter(
  terminal: Locator,
  target: string,
): Promise<{ x: number; y: number } | undefined> {
  const surface = terminal.getByTestId("terminal-surface");
  const lines = ((await terminalText(terminal).textContent()) ?? "").split("\n");
  const row = lines.findLastIndex((line) => line.includes(target));
  const box = await surface.locator("canvas").boundingBox();
  const cols = Number(await surface.getAttribute("data-cols"));
  const rows = Number(await surface.getAttribute("data-rows"));
  if (row < 0 || box === null || !(cols > 0) || !(rows > 0)) return undefined;
  const column = lines[row]!.lastIndexOf(target) + target.length / 2;
  return {
    x: box.x + (column * box.width) / cols,
    y: box.y + ((row + 0.5) * box.height) / rows,
  };
}

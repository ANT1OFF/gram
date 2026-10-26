import { expect, test } from "@playwright/test";

import { terminalText } from "./terminal";

test("finds in the terminal: highlights matches, steps through them, and Esc returns to the shell", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();

  const terminal = panel.getByTestId("terminal").first();
  const rows = terminalText(terminal);
  await expect(rows).toContainText("$", { timeout: 15_000 });
  await terminal.getByTestId("terminal-surface").click();

  // The mock shell echoes each line, so two of these become `echo: needle …` rows.
  for (const line of ["needle one", "hay", "needle two"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await expect(rows).toContainText("echo: needle two");

  await page.keyboard.press("ControlOrMeta+KeyF");
  const bar = terminal.getByTestId("terminal-find-bar");
  const field = bar.getByRole("textbox", { name: "Find in terminal" });
  await expect(field).toBeFocused();
  // The thread's own find bar stays closed: ⌘F belongs to the focused terminal.
  await expect(page.getByTestId("find-bar")).toHaveCount(0);

  await field.fill("echo: needle");
  const status = bar.getByTestId("terminal-find-status");
  await expect(status).toHaveText(/^[12] of 2$/);
  // Each match is a box laid over its cells: the warning tint on a match, the accent on the active
  // one, which also takes the outline. Both rows also hold the typed line's echo of `needle`.
  const matches = terminal.locator("[data-terminal-find-match]");
  await expect(matches).toHaveCount(2);
  const tints = () => matches.evaluateAll((boxes) => boxes.map((box) => box.style.backgroundColor));
  await expect.poll(async () => new Set(await tints()).size).toBe(2);
  const active = terminal.locator("[data-terminal-find-match='active']");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveCSS("outline-style", "solid");
  // Over the text it names: a row of the grid high, and as wide as the term is long.
  const surface = terminal.getByTestId("terminal-surface");
  const canvas = (await surface.locator("canvas").boundingBox())!;
  const box = (await active.boundingBox())!;
  const cell = {
    width: canvas.width / Number(await surface.getAttribute("data-cols")),
    height: canvas.height / Number(await surface.getAttribute("data-rows")),
  };
  expect(box.width).toBeCloseTo("echo: needle".length * cell.width, 0);
  expect(box.height).toBeCloseTo(cell.height, 0);
  expect((box.x - canvas.x) / cell.width).toBeCloseTo(0, 0);

  const first = (await status.textContent()) ?? "";
  await field.press("Enter");
  await expect(status).not.toHaveText(first);
  await field.press("Shift+Enter");
  await expect(status).toHaveText(first);
  await page.keyboard.press("ControlOrMeta+KeyG");
  await expect(status).not.toHaveText(first);
  await page.keyboard.press("ControlOrMeta+Shift+KeyG");
  await expect(status).toHaveText(first);

  await field.fill("ECHO: NEEDLE");
  await expect(status).toHaveText(/^[12] of 2$/);
  await bar.getByRole("button", { name: "Match case" }).click();
  await expect(status).toHaveText("No matches");
  await bar.getByRole("button", { name: "Match case" }).click();

  await field.press("Escape");
  await expect(bar).toBeHidden();
  await expect(matches).toHaveCount(0);
  await expect.poll(() => surface.evaluate((el) => el.contains(document.activeElement))).toBe(true);
});

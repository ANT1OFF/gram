import { expect, test } from "@playwright/test";

import { cellCenter, terminalText } from "./terminal";

test("opens a path:line from terminal output in the editor, and zooms the terminal", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();

  const terminal = panel.getByTestId("terminal").first();
  const rows = terminalText(terminal);
  const surface = terminal.getByTestId("terminal-surface");
  await expect(rows).toContainText("$", { timeout: 15_000 });
  await surface.click();

  // The mock shell echoes each line, so the echo carries a checkout path:line.
  await page.keyboard.type("src/retry.ts:12");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("echo: src/retry.ts:12");
  // Aim at the link text itself, by its cells: the row spans the whole terminal, so its width says
  // nothing about where the text ends.
  const link = await cellCenter(terminal, "src/retry.ts:12");
  if (!link) throw new Error("the screen has no src/retry.ts:12 text");
  await page.mouse.move(link.x, link.y);
  await page.mouse.click(link.x, link.y);
  await expect(
    page
      .getByTestId("toast")
      .filter({ hasText: "Opening in VS Code" })
      .filter({ hasText: "retry.ts" }),
  ).toBeVisible();

  // A bigger font is fewer columns in the same pane; the size alone would only echo the setting.
  const fontSize = async () =>
    `${await surface.getAttribute("data-font-size")}/${await surface.getAttribute("data-cols")}`;
  const before = await fontSize();
  await surface.click();
  await page.keyboard.press("ControlOrMeta+Equal");
  await expect.poll(fontSize).not.toBe(before);
  await page.keyboard.press("ControlOrMeta+Minus");
  await expect.poll(fontSize).toBe(before);
  // As typed on a Nordic keyboard, where + has a key of its own: the same zoom-in, not the window's.
  await page.keyboard.press("ControlOrMeta++");
  await expect.poll(fontSize).not.toBe(before);
  await page.keyboard.press("ControlOrMeta+Digit0");
  await expect.poll(fontSize).toBe(before);
});

test("copies the selection on the platform's chord, and leaves the clipboard alone until then", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/t/t-flaky");
  const panel = page.getByTestId("right-panel");
  await panel.getByRole("tab", { name: "Terminal", exact: true }).click();
  const terminal = panel.getByTestId("terminal").first();
  await expect(terminalText(terminal)).toContainText("$", { timeout: 15_000 });
  await terminal.getByTestId("terminal-surface").click();
  await page.keyboard.type("copyme-7431");
  await page.keyboard.press("Enter");
  await expect(terminalText(terminal)).toContainText("echo: copyme-7431");

  await page.evaluate(() => navigator.clipboard.writeText("what the user had"));
  const word = await cellCenter(terminal, "copyme-7431");
  if (!word) throw new Error("the screen has no copyme-7431 text");
  await page.mouse.dblclick(word.x, word.y);
  // The emulator's own default is to copy as soon as something is selected.
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("what the user had");

  // The selection lives on a canvas, so the browser's copy has nothing to take on its own.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+KeyC" : "Control+Shift+KeyC");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("copyme-7431");
});

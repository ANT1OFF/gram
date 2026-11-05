import { expect, test } from "@playwright/test";

import { openOrchestrator, threadRow } from "./thread-row";

// ⌘K unfiltered: places to go first (Workers, Memory, Quiet…) with their keys, then the latest
// threads and workers, each group capped with Show more; filters under the field for one kind.
// The mock's invented workspace and threads, never a real account's.

test("the palette opens short on destinations, filters by kind and lists a group in full", async ({
  page,
}) => {
  // A 1440 × 900 window, the smaller of the real ones the tour captures.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await threadRow(page, "t-flaky").waitFor();
  const made = await page.evaluate(() => window.gramMock!.simulateOrchestration("board"));
  await openOrchestrator(page, made.orchestratorThreadId);
  await page.getByLabel("Message", { exact: true }).waitFor();

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByTestId("command-palette");
  const groups = palette.getByRole("group");
  await expect(groups.first()).toHaveAccessibleName("Go to");
  const suggested = palette.getByRole("group", { name: "Go to" }).getByRole("option");
  await expect(suggested.nth(0)).toContainText("Workers");
  await expect(suggested.nth(0).locator("kbd")).toHaveText(/J$/);
  await expect(suggested.nth(1)).toContainText("Memory");
  await expect(suggested.nth(2)).toContainText("Quiet");
  // Opened short: it fits its box without scrolling past the fold.
  const results = palette.locator("#palette-results");
  const fits = await results.evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  expect(fits).toBe(true);

  // The filters under the field: Workers alone, and every one of them behind Show more.
  const kinds = palette.getByRole("radiogroup", { name: "Show" });
  await expect(kinds.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
  await kinds.getByRole("radio", { name: "Workers" }).click();
  await expect(palette.getByRole("combobox")).toBeFocused();
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toHaveAccessibleName("Workers");
  // A > lists actions, whatever is picked: the Actions filter shows it.
  await palette.getByRole("combobox").fill(">");
  await expect(kinds.getByRole("radio", { name: "Actions" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(palette.getByRole("group", { name: "Go to" })).toBeVisible();
  const commands = palette.getByRole("group", { name: "Commands" });
  const more = commands.locator('[data-more="true"]');
  await expect(more).toHaveText(/^Show \d+ more$/);
  const before = await commands.getByRole("option").count();
  await more.click();
  await expect(more).toHaveCount(0);
  expect(await commands.getByRole("option").count()).toBeGreaterThan(before);

  // A destination gone to leads the next opening as Recent.
  await kinds.getByRole("radio", { name: "All" }).click();
  await expect(palette.getByRole("combobox")).toHaveValue("");
  await palette.getByRole("group", { name: "Go to" }).getByText("Memory").click();
  await expect(page).toHaveURL(/\/memory$/);
  await page.keyboard.press("ControlOrMeta+k");
  const first = palette.getByRole("group", { name: "Go to" }).getByRole("option").first();
  await expect(first).toContainText("Memory");
  await expect(first).toContainText("Recent");
});

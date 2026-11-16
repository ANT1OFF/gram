import { expect, test, type Page } from "@playwright/test";

import { slowdown } from "./slowdown";
import { threadRow } from "./thread-row";

/** Opens `t-flaky`, gives `t-deps` a recap, then moves to `t-deps` the way a user comes back to it. */
const comeBackToDeps = async (page: Page, delayMs = 0) => {
  await page.goto("/t/t-flaky");
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
  await page.evaluate(
    (delay) => window.gramMock?.simulateRecap("t-deps" as never, { delayMs: delay }),
    delayMs,
  );
  await threadRow(page, "t-deps").click();
};

const helperEvents = (page: Page) =>
  page.evaluate(() =>
    window.gramMock
      ?.helperEvents()
      .filter((e) => e.kind === "recap")
      .map((e) => `${e.kind}.${e.event}`),
  );

test("a recap's facts open the diff, and its next step goes into the composer, undoably", async ({
  page,
}) => {
  await comeBackToDeps(page, 800);
  // A recap the server has to make first says it's coming.
  await expect(page.getByTestId("recap-pending")).toBeVisible();
  const recap = page.getByRole("region", { name: "Where you left off" });
  await expect(recap.getByTestId("recap-next")).toBeVisible({ timeout: 5_000 * slowdown });
  await expect(page.getByTestId("recap-pending")).toHaveCount(0);
  await expect.poll(() => helperEvents(page)).toEqual(["recap.shown"]);
  // The changed files open the diff, and the next step goes into the composer, unsent.
  await recap.getByRole("list", { name: "Facts" }).getByRole("button").first().click();
  await expect(page.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
  const next = (await recap.getByTestId("recap-next").textContent())?.trim() ?? "";
  expect(next).not.toBe("");
  await recap.getByRole("button", { name: "Put the next step in the composer" }).click();
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toHaveValue(next);
  await expect(composer).toBeFocused();
  // Typed in, so ⌘Z takes it back out.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(composer).toHaveValue("");
  await expect(recap).toBeVisible();

  await recap.getByRole("button", { name: "Dismiss the recap" }).click();
  await expect(page.getByTestId("recap")).toHaveCount(0);
  await expect.poll(() => helperEvents(page)).toEqual(["recap.shown", "recap.dismissedFast"]);
});

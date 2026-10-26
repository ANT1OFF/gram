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

test("opening an idle thread shows where you left off, what's next and the facts", async ({
  page,
}) => {
  await comeBackToDeps(page, 800);
  // A recap the server has to make first says it's coming.
  await expect(page.getByTestId("recap-pending")).toBeVisible();
  const recap = page.getByRole("region", { name: "Where you left off" });
  await expect(recap).toContainText("the agent fixed the two zod 4 type errors", {
    timeout: 5_000 * slowdown,
  });
  await expect(page.getByTestId("recap-pending")).toHaveCount(0);
  await expect(recap.getByTestId("recap-next")).toHaveText("Run the e2e suite against Vite 8.3");
  await expect(recap.getByTestId("recap-progress")).toContainText("2 of 3");
  await expect(recap.getByRole("list", { name: "Facts" }).getByRole("listitem")).toHaveText([
    "14 files changed",
    "not pushed",
    "no PR yet",
  ]);
  await expect.poll(() => helperEvents(page)).toEqual(["recap.shown"]);
  // The changed files open the diff, and the next step goes into the composer, unsent.
  await recap.getByRole("button", { name: "14 files changed" }).click();
  await expect(page.getByRole("tab", { name: "Diff" })).toHaveAttribute("aria-selected", "true");
  await recap.getByRole("button", { name: "Put the next step in the composer" }).click();
  const composer = page.getByLabel("Message", { exact: true });
  await expect(composer).toHaveValue("Run the e2e suite against Vite 8.3");
  await expect(composer).toBeFocused();
  // Typed in, so ⌘Z takes it back out.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(composer).toHaveValue("");
  await expect(recap).toBeVisible();

  await recap.getByRole("button", { name: "Dismiss the recap" }).click();
  await expect(page.getByTestId("recap")).toHaveCount(0);
  await expect.poll(() => helperEvents(page)).toEqual(["recap.shown", "recap.dismissedFast"]);
});

test("the recap goes once you send", async ({ page }) => {
  await comeBackToDeps(page);
  const recap = page.getByRole("region", { name: "Where you left off" });
  await expect(recap).toBeVisible();
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Run the e2e suite against Vite 8.3");
  await composer.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("recap")).toHaveCount(0);
  await expect.poll(() => helperEvents(page)).toEqual(["recap.shown"]);
});

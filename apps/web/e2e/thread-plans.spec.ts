import { expect, test } from "@playwright/test";
import { threadRow } from "./thread-row";

// A thread's plan, in the strip under its header: where it stands, folded to one line, and its
// steps to edit, opened. The overview's rows carry no plan of their own.

test("a planned thread's header strip says where it stands, and edits the plan", async ({
  page,
}) => {
  await page.goto("/t/t-deps");
  // Folded, the strip is one line; opened, it lists the steps and who wrote each.
  const strip = page.getByTestId("plan-strip");
  const headline = strip.getByTestId("plan-strip-headline");
  const count = strip.getByTestId("plan-strip-count");
  const ring = strip.getByTestId("plan-ring");
  await expect(strip).toContainText("Bump the API's dependencies");
  await expect(headline).toContainText("Next: Run e2e against Vite 8.3");
  await expect(count).toHaveText("2/3");
  await expect(ring).toHaveAttribute("data-share", String(2 / 3));
  await expect(strip.getByTestId("plan-step")).toHaveCount(0);
  await strip.getByRole("button", { name: /^Plan: / }).click();
  const steps = strip.getByTestId("plan-step");
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(2)).toContainText("Kept by the helper");

  // A click on a step's glyph moves its status on, and the edit makes the step the user's.
  await steps
    .nth(2)
    .getByRole("button", { name: /^To do: Run e2e/ })
    .click();
  await expect(steps.nth(2)).toHaveAttribute("data-status", "doing");
  await expect(steps.nth(2).getByRole("button", { name: /Let the helper update/ })).toBeVisible();

  // Rewording a step keeps its place; a new step goes at the end.
  await steps.nth(2).hover();
  await steps
    .nth(2)
    .getByRole("button", { name: /^Edit “Run e2e/ })
    .click();
  const field = strip.getByRole("textbox", { name: "Step" });
  await field.fill("Run e2e against Vite 8.3 and 8.4");
  await field.press("Enter");
  await expect(steps.nth(2)).toContainText("Run e2e against Vite 8.3 and 8.4");
  await strip.getByRole("button", { name: "Add step" }).click();
  const added = strip.getByRole("textbox", { name: "New step" });
  await added.fill("Open a PR");
  await added.press("Enter");
  await expect(steps).toHaveCount(4);
  await expect(count).toHaveText("2/4");

  // Every step done: the ring turns to a check, and the strip says just that.
  await steps
    .nth(2)
    .getByRole("button", { name: /^In progress: / })
    .click();
  await steps
    .nth(3)
    .getByRole("button", { name: /^To do: Open a PR/ })
    .click();
  await steps
    .nth(3)
    .getByRole("button", { name: /^In progress: Open a PR/ })
    .click();
  await expect(ring).toHaveAttribute("data-share", "1");
  await expect(count).toHaveText("4/4");
  await expect(headline).toHaveText("· Done");
});

test("the agent's todo list stands in for a plan it hasn't got", async ({ page }) => {
  await page.goto("/t/t-background");
  await expect(threadRow(page, "t-background")).toBeVisible();
  // The mock hook is set once the app has created its API, which can be after the first paint.
  await page.waitForFunction(() => window.gramMock !== undefined);
  await page.evaluate(() =>
    window.gramMock!.simulateTurnPlan("t-background" as never, [
      { content: "List the files", status: "completed" },
      { content: "Group them by folder", status: "inProgress", activeForm: "Grouping by folder" },
    ]),
  );
  const strip = page.getByTestId("plan-strip");
  await expect(strip.getByTestId("plan-strip-count")).toHaveText("1/2");
  await strip.getByRole("button", { name: /^Plan: / }).click();
  await expect(strip.getByTestId("plan-step")).toHaveCount(2);
  await expect(strip).toContainText("The agent's todo list");
  await expect(strip.getByTestId("plan-strip-headline")).toContainText("Next: Grouping by folder");
});

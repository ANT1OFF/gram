import { expect, test, type Page } from "@playwright/test";

import { threadRow } from "./thread-row";

// Round 12's review problems: the Focus review strip answers the approval it shows and reads a
// message's Markdown, Focus review keeps the tabs the panel had, an empty scope shows no other
// scope's totals, and a large diff opens on its first readable file.

const panel = (page: Page) => page.getByTestId("right-panel");

/** The right panel's tabs in its strip, in order, named or not. */
const tabNames = (page: Page) =>
  panel(page)
    .locator("[data-panel-tab]")
    .evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-panel-tab")));

const enterFocus = async (page: Page) => {
  await panel(page).getByRole("button", { name: "Focus review" }).click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-review-focus", "true");
  await expect(page.getByTestId("review-strip")).toHaveAttribute("data-readable", "true");
};

test("the strip answers the approval it shows, with its verbs and its keys", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByTestId("approval-card").waitFor();
  await enterFocus(page);

  const strip = page.getByTestId("review-strip");
  const card = strip.getByTestId("approval-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("git push origin fix/flaky-retry");
  await expect(card.getByTestId("approval-allow")).toContainText("Allow once");
  await expect(card.getByTestId("approval-always")).toBeVisible();
  await expect(card.getByTestId("approval-deny")).toBeVisible();
  // The card says it all: no second row for the same approval pointing back to the chat.
  await expect(strip.getByTestId("review-strip-waiting")).toHaveCount(0);
  await expect(strip.getByText("Answer in the conversation")).toHaveCount(0);

  // "Always allow this rule…" shows what it would keep before keeping it, as in the thread.
  await card.getByTestId("approval-always").click();
  await expect(card.getByTestId("approval-always-rule")).toContainText("Bash(");
  await card.getByTestId("approval-always-back").click();

  // A key pressed with focus in the diff is the diff's, never an answer.
  await panel(page).locator("[data-diff-file-header]").first().focus();
  await page.keyboard.press("1");
  await expect(card).toBeVisible();

  // With focus in the strip, 1 allows it once, and the receipt says so where the card was.
  await card.click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("1");
  await expect(card).toHaveCount(0);
  await expect(strip.getByTestId("approval-receipt")).toContainText("Allowed once");
  // Still in focus: answering didn't hand the window back.
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-review-focus", "true");
});

test("the strip reads a message's links as links, and opens the conversation", async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  const made = await page.evaluate(async () => {
    const started = await window.gramMock!.startedRealistic();
    if (started === undefined) throw new Error("the mock did not start the realistic scenario");
    return started;
  });
  await threadRow(page, made.searchWorker).click();
  await page.waitForURL(new RegExp(`/t/${made.searchWorker}$`));
  await panel(page).getByRole("button", { name: "Focus review" }).waitFor();
  await enterFocus(page);

  const latest = page.getByTestId("review-strip-latest");
  await expect(latest).toContainText("Opened #142.");
  await expect(latest).not.toContainText("](");
  await expect(latest).not.toContainText("https://");
  // The link is its text, and says where it goes on hover.
  const link = latest.getByText("#142", { exact: true });
  await expect(link).toHaveAttribute("title", "https://github.com/example/gram/pull/142");

  await page.getByTestId("review-strip-open").click();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-review-focus", "false");
  await expect(page.locator("main")).not.toHaveAttribute("inert");
});

test("Focus review keeps the panel's tabs, in order, with the rest under More", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/t/t-flaky");
  await page.getByTestId("diff-panel").waitFor();
  await expect(panel(page).getByTestId("panel-more")).toBeVisible();
  const beside = await tabNames(page);
  expect(beside).toEqual(["diff", "pr", "files", "terminal"]);

  await enterFocus(page);
  // The panel is far wider now, and still shows the same tabs, the rarer ones in More.
  await expect.poll(() => tabNames(page)).toEqual(beside);
  await expect(panel(page).getByTestId("panel-more")).toBeVisible();
  await panel(page).getByTestId("panel-more").click();
  const menu = page.getByTestId("panel-more-menu");
  await expect(menu.getByRole("menuitem", { name: "Preview" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Notifications" })).toBeVisible();
});

test("an empty Uncommitted scope shows no totals, and Branch shows the branch's", async ({
  page,
}) => {
  await page.goto("/t/t-docs");
  const diff = page.getByTestId("diff-panel");
  await diff.getByTestId("diff-file").first().waitFor();
  await expect(diff.getByRole("radio", { name: "Branch" })).toHaveAttribute("aria-checked", "true");
  await expect(diff.getByTestId("diff-summary")).toHaveAttribute("data-files", "1");

  await diff.getByRole("radio", { name: "Uncommitted" }).click();
  await expect(diff.getByTestId("diff-empty")).toContainText("No uncommitted changes");
  await expect(diff.getByTestId("diff-summary")).toHaveCount(0);

  await diff.getByTestId("diff-empty-action").click();
  await expect(diff.getByTestId("diff-summary")).toHaveAttribute("data-files", "1");
});

test("a large diff opens on its first readable file, its image and lockfile still folded", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const diff = page.getByTestId("diff-panel");
  await diff.getByTestId("diff-file").first().waitFor();
  const header = (path: string) =>
    diff.locator(`[data-testid="diff-file"][data-path="${path}"] [data-diff-file-header]`);
  await expect(header("docs/testing.md")).toHaveAttribute("aria-expanded", "true");
  await expect(header("assets/retry-timeline.png")).toHaveAttribute("aria-expanded", "false");
  await expect(header("pnpm-lock.yaml")).toHaveAttribute("aria-expanded", "false");
  await expect(header("src/retry.test.ts")).toHaveAttribute("aria-expanded", "false");
  await expect(diff.getByTestId("patch")).toHaveCount(1);
});

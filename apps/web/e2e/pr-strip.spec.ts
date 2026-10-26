import { expect, test } from "@playwright/test";

test("the thread's PR sits above the composer with its diff and checks", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const row = page.getByTestId("pr-row");
  await expect(row).toContainText("#412");
  await expect(row).toContainText("api");
  await expect(row.getByTestId("pr-row-branch")).toHaveText("fix/flaky-retry");
  await expect(row.getByRole("img", { name: "Checks failing" })).toBeVisible();
  await expect(row.getByTestId("pr-row-diff")).toHaveText("+2−1");

  await row.getByTestId("pr-row-ci").click();
  const menu = page.getByTestId("pr-ci-menu");
  await expect(menu.getByTestId("pr-ci-bucket")).toHaveText(["Failed1", "Running1", "Passed2"]);
});

test("watching CI from the row binds the PR, and its CI menu unbinds it", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const row = page.getByTestId("pr-row");
  await row.getByTestId("pr-row-ci").click();
  const menu = page.getByTestId("pr-ci-menu");
  await expect(menu.getByRole("button", { name: "Unbind #412" })).toHaveCount(0);
  const watch = menu.getByRole("switch", { name: "Watch CI" });
  await watch.click();
  await expect(watch).toBeChecked();

  await menu.getByRole("button", { name: "Unbind #412" }).click();
  await expect(menu.getByRole("button", { name: "Unbind #412" })).toHaveCount(0);
  await expect(watch).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(row).toContainText("#412");
});

test("× hides the row without unbinding it, and the hidden count brings it back", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const strip = page.getByTestId("pr-strip");
  const row = strip.getByTestId("pr-row");
  await row.getByTestId("pr-row-ci").click();
  await page.getByTestId("pr-ci-menu").getByRole("switch", { name: "Watch CI" }).click();
  await page.keyboard.press("Escape");

  // Its checks were already failing when it was hidden, so they don't bring it back.
  await row.getByRole("button", { name: "Hide #412 from this thread's PR list" }).click();
  await expect(row).toHaveCount(0);
  const restore = strip.getByRole("button", { name: "Show 1 hidden PR" });
  await expect(restore).toHaveText("1 hidden");

  await restore.click();
  await expect(row).toContainText("#412");
  await row.getByTestId("pr-row-ci").click();
  await expect(
    page.getByTestId("pr-ci-menu").getByRole("switch", { name: "Watch CI" }),
  ).toBeChecked();
});

test("the row's number opens the PR panel, and shows the PR on hover", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const number = page.getByTestId("pr-row").getByTestId("pr-row-number");
  await number.hover();
  const card = page.getByTestId("pr-row-card");
  await expect(card).toContainText("example/api #412");
  await expect(card).toContainText("Make the retry test deterministic");
  await expect(card).toContainText("alex");
  await number.click();
  await expect(page.getByTestId("pr-panel")).toBeVisible();
});

test("the row says where the review bot stands, and opens its findings", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const chip = page.getByTestId("pr-row").getByTestId("pr-row-review");
  await expect(chip).toHaveText("2 blockers");
  await expect(chip).toHaveAttribute("data-state", "blockers");
  await chip.click();
  await expect(
    page.getByTestId("right-panel").getByTestId("review-panel").getByTestId("review-verdict"),
  ).toContainText("Changes requested");
});

test("the repository and the branch each have their own menu", async ({ page }) => {
  await page.goto("/t/t-flaky");
  const row = page.getByTestId("pr-row");
  await row.getByTestId("pr-row-repo").click();
  const repoMenu = page.getByTestId("pr-row-repo-menu");
  await expect(repoMenu.getByRole("menuitem")).toHaveText([
    /in (Finder|Explorer|file manager)/,
    "Open repository on GitHub",
    "Copy path",
    "Open in terminal",
  ]);
  await page.keyboard.press("Escape");

  await row.getByTestId("pr-row-branch").click();
  const branchMenu = page.getByTestId("pr-row-branch-menu");
  await expect(branchMenu.getByRole("menuitem", { name: "Copy branch name" })).toBeVisible();
  await branchMenu.getByRole("menuitem", { name: "Open in terminal" }).click();
  await expect(page.getByTestId("terminal-panel")).toBeVisible();
});

test("a thread follows more PRs beside its own, folded, promotes one and drops one", async ({
  page,
}) => {
  await page.goto("/t/t-flaky");
  const strip = page.getByTestId("pr-strip");
  await strip.getByTestId("pr-row").getByTestId("pr-row-ci").click();
  await page.getByTestId("pr-ci-menu").getByRole("switch", { name: "Watch CI" }).click();
  await expect(page.getByRole("button", { name: "Unbind #412" })).toBeVisible();
  await page.keyboard.press("Escape");

  const follow = async (ref: string) => {
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByTestId("command-palette");
    await palette.getByRole("combobox").fill(">Follow another");
    await palette.getByRole("combobox").press("Enter");
    const dialog = page.getByTestId("bind-pr-dialog");
    await expect(dialog).toContainText("The PR panel stays on #412");
    await dialog.getByLabel("Pull request number or URL").fill(ref);
    await dialog.getByRole("button", { name: "Follow" }).click();
    await expect(dialog).toBeHidden();
  };
  await follow("example/web#9");
  await follow("example/infra#10");

  const extras = strip.getByTestId("pr-row-extra");
  // More than one row starts folded, behind the thread's own.
  await expect(extras).toHaveCount(0);
  await strip.getByRole("button", { name: "Show 2 more" }).click();
  await expect(extras).toHaveCount(2);
  await expect(extras.first()).toContainText("#9");
  await expect(extras.first()).toContainText("web");
  await expect(extras.first().getByTestId("pr-row-branch")).toHaveText("feat/pr-9");
  // A PR from another repository has no folder here, so its menu offers neither it nor a terminal.
  await extras.first().getByTestId("pr-row-repo").click();
  await expect(page.getByTestId("pr-row-repo-menu").getByRole("menuitem")).toHaveText([
    "Open repository on GitHub",
    "Copy repository name",
  ]);
  await page.keyboard.press("Escape");
  await expect(extras.first().getByRole("img", { name: "Ready, checks passing" })).toBeVisible();
  await expect(extras.nth(1).getByRole("img", { name: "Checks failing" })).toBeVisible();

  await strip.getByRole("button", { name: "Show less" }).click();
  await expect(extras).toHaveCount(0);
  await strip.getByRole("button", { name: "Show 2 more" }).click();
  await expect(extras).toHaveCount(2);

  await extras.first().getByTestId("pr-row-ci").click();
  await page.getByRole("button", { name: "Make #9 this thread's PR" }).click();
  await expect(strip.getByTestId("pr-row")).toContainText("#9");
  await expect(extras.filter({ hasText: "#412" })).toHaveCount(1);
  await page.keyboard.press("Escape");

  await extras.filter({ hasText: "#10" }).getByTestId("pr-row-ci").click();
  await page.getByRole("button", { name: "Stop following #10" }).click();
  await expect(extras).toHaveCount(1);
});

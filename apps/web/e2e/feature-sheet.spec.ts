import { expect, test, type Page } from "@playwright/test";

import { openOrchestrator, pressFirstWorkspaceKey } from "./thread-row";

// A feature you can open and act on: its sheet from the Board
// and from its card in the stream, and its menu. Mock state lives in memory, so every step after
// the seed navigates inside the app; nothing reloads.

const seed = async (page: Page) => {
  await page.goto("/t/t-flaky");
  await page.getByLabel("Message", { exact: true }).waitFor();
};

const openBoard = async (page: Page) => {
  await seed(page);
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
  return made;
};

const line = (page: Page, feature: string) =>
  page.getByTestId("rail-board").locator(`[data-testid="rail-row"][data-feature="${feature}"]`);
const sheet = (page: Page) => page.getByTestId("feature-sheet");

test("a feature's name on the Board opens its sheet: stations, PRs, workers; Esc closes it", async ({
  page,
}) => {
  const made = await openBoard(page);
  await line(page, "mail-trigger").getByTestId("rail-feature").click();
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).getByRole("heading", { name: "mail-trigger" })).toBeVisible();

  // The counts add up to the line's chips.
  const chips = await line(page, "mail-trigger").getByTestId("rail-worker").count();
  const counts = await sheet(page)
    .getByTestId("feature-sheet-stations")
    .locator("li")
    .evaluateAll((items) => items.map((item) => Number((item as HTMLElement).dataset["count"])));
  expect(counts).toHaveLength(5);
  expect(counts.reduce((a, b) => a + b, 0)).toBe(chips);
  await expect(sheet(page).getByTestId("feature-sheet-worker")).toHaveCount(chips);
  // The three pushers wait on you.
  await expect(sheet(page).getByTestId("feature-sheet-needs")).toHaveText("3 need you");
  for (const pusher of made.pushers) {
    await expect(
      sheet(page).locator(`[data-testid="feature-sheet-worker"][data-thread-id="${pusher}"]`),
    ).toHaveAttribute("data-tone", "needs");
  }
  await expect(sheet(page).getByTestId("feature-sheet-pr").first()).toBeVisible();

  // Esc closes the sheet and leaves you on the Board.
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByTestId("rail-board")).toBeVisible();
});

test("a worker in the sheet opens its worker view", async ({ page }) => {
  const made = await openBoard(page);
  await line(page, "mail-trigger").getByTestId("rail-feature").click();
  await sheet(page)
    .locator(`[data-testid="feature-sheet-worker"][data-thread-id="${made.working}"]`)
    .getByRole("button")
    .click();
  await expect(page).toHaveURL(new RegExp(`/t/${made.working}$`));
  await expect(sheet(page)).toBeHidden();
  await expect(page.getByTestId("view-board")).toBeHidden();
});

test("the helper's sentence shows in the sheet", async ({ page }) => {
  await seed(page);
  const text = "Endpoint in review, waiting on the form; three branches ready to push.";
  await page.evaluate(
    (armed) => window.gramMock!.simulateFeatureSummary(armed.feature, armed.text),
    { feature: "mail-trigger", text },
  );
  const made = await page.evaluate(() => window.gramMock!.simulateAsks());
  await openOrchestrator(page, made.orchestratorThreadId);
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await line(page, "mail-trigger").getByTestId("rail-feature").click();
  await expect(sheet(page).getByTestId("feature-sheet-summary")).toHaveText(text);
});

test("the feature menu: Ask about it fills the orchestrator's composer and sends nothing", async ({
  page,
}) => {
  const made = await openBoard(page);
  await line(page, "mail-trigger").getByTestId("feature-menu").press("Enter");
  const menu = page.getByTestId("feature-menu-popup");
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Open",
    "Ask about it",
    /^(Set stage|Edit plan)…$/,
    "Move to group",
    "Pause",
    "Rename",
    "Archive",
  ]);
  await menu.getByRole("menuitem", { name: "Ask about it" }).press("Enter");

  await expect(page.getByTestId("view-board")).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const composer = page.locator("[data-pane-root]").getByLabel("Message", { exact: true });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(/^About the feature mail-trigger: /);
  await expect(composer).toHaveValue(new RegExp(`\\[thread ${made.working}\\]`));
  // Nothing was sent: the words wait in the composer.
  await expect(
    page.getByTestId("transcript").getByText("About the feature mail-trigger"),
  ).toHaveCount(0);
});

test("Archive parks a quiet feature's workers and it leaves the Board; a busy one says why", async ({
  page,
}) => {
  // The One thread scenario: its board has finished features beside live ones.
  await seed(page);
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  await page
    .getByRole("radiogroup", { name: "View" })
    .getByRole("radio", { name: /^Board\b/ })
    .click();
  await expect(page.getByTestId("rail-board")).toBeVisible();
  // mail-trigger's pushers wait on you: archiving would only hide them.
  await line(page, "mail-trigger").getByTestId("feature-menu").press("Enter");
  await page
    .getByTestId("feature-menu-popup")
    .getByRole("menuitem", { name: "Archive" })
    .press("Enter");
  await expect(page.getByText("Couldn't archive mail-trigger")).toBeVisible();
  await expect(line(page, "mail-trigger")).toBeVisible();

  // auth-refresh is merged, with nothing running: from its sheet, Archive takes it off. Its group,
  // q3-cleanup, is finished, so its band is folded to one line until opened. It is the Board's last
  // entry, drawn once scrolled to.
  await page
    .getByTestId("rail-board")
    .getByRole("list", { name: "Features", exact: true })
    .evaluate((list) => {
      list.closest<HTMLElement>(".overflow-y-auto")!.scrollTop = 1e6;
    });
  await page
    .getByTestId("rail-board")
    .locator('[data-testid="rail-group"][data-group="q3-cleanup"]')
    .getByTestId("rail-group-toggle")
    .click();
  await line(page, "auth-refresh").getByTestId("rail-feature").click();
  await sheet(page).getByTestId("feature-menu").press("Enter");
  const items = page.getByTestId("feature-menu-popup").getByRole("menuitem");
  await expect(items).toHaveText([
    "Ask about it",
    /^(Set stage|Edit plan)…$/,
    "Move to group",
    "Pause",
    "Rename",
    "Archive",
  ]);
  await items.filter({ hasText: "Archive" }).press("Enter");
  await expect(sheet(page)).toBeHidden();
  await expect(line(page, "auth-refresh")).toHaveCount(0);
  await expect(line(page, "mail-trigger")).toBeVisible();
});

test("a live feature card's name in the stream opens the same sheet", async ({ page }) => {
  await seed(page);
  const made = await page.evaluate(() => window.gramMock!.simulateOneThread());
  await pressFirstWorkspaceKey(page);
  await expect(page).toHaveURL(new RegExp(`/t/${made.orchestratorThreadId}$`));
  const card = page.getByTestId("feature-card").first();
  await expect(card).toBeVisible();
  const feature = await card.getAttribute("data-feature");
  await card.getByTestId("feature-card-open").click();
  await expect(sheet(page)).toHaveAttribute("data-feature", feature!);
  await expect(sheet(page).getByRole("heading", { name: feature! })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
});

const pick = async (page: Page, menu: ReturnType<Page["getByTestId"]>, item: string) => {
  await menu.getByTestId("feature-menu").press("Enter");
  await page.getByTestId("feature-menu-popup").getByRole("menuitem", { name: item }).press("Enter");
};

test("Pause stops a feature's running worker and the Board and sheet say Paused; Resume lifts it", async ({
  page,
}) => {
  const made = await openBoard(page);
  const chip = line(page, "mail-trigger").locator(
    `[data-testid="rail-worker"][data-thread-id="${made.working}"]`,
  );
  await expect(chip).toHaveAttribute("data-tone", "working");
  await expect(line(page, "mail-trigger").getByTestId("rail-paused")).toHaveCount(0);

  await pick(page, line(page, "mail-trigger"), "Pause");
  await expect(line(page, "mail-trigger").getByTestId("rail-paused")).toHaveText("Paused");
  // Its running worker was stopped; the other features carry on.
  await expect(chip).toHaveAttribute("data-tone", "idle");
  await expect(page.getByTestId("rail-paused")).toHaveCount(1);

  // The sheet says so too, and its menu offers Resume.
  await line(page, "mail-trigger").getByTestId("rail-feature").click();
  await expect(sheet(page).getByTestId("feature-sheet-paused")).toHaveText("Paused");
  await sheet(page).getByTestId("feature-menu").press("Enter");
  await expect(page.getByTestId("feature-menu-popup").getByRole("menuitem")).toHaveText([
    "Ask about it",
    /^(Set stage|Edit plan)…$/,
    "Move to group",
    "Resume",
    "Rename",
    "Archive",
  ]);
  await page
    .getByTestId("feature-menu-popup")
    .getByRole("menuitem", { name: "Resume" })
    .press("Enter");
  await expect(sheet(page).getByTestId("feature-sheet-paused")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toBeHidden();
  await expect(line(page, "mail-trigger").getByTestId("rail-paused")).toHaveCount(0);
});

test("Rename gives a feature its new slug on the Board and in its sheet; a taken name is refused", async ({
  page,
}) => {
  const made = await openBoard(page);
  const workers = await line(page, "mail-trigger").getByTestId("rail-worker").count();
  const others = await page
    .getByTestId("rail-row")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset["feature"]!));
  const taken = others.find((feature) => feature !== "mail-trigger")!;

  // From the sheet: the name another feature has is refused, and nothing moves.
  await line(page, "mail-trigger").getByTestId("rail-feature").click();
  await pick(page, sheet(page), "Rename");
  const dialog = page.getByTestId("feature-rename-dialog");
  const name = dialog.getByLabel("Feature name");
  await expect(name).toBeFocused();
  await expect(name).toHaveValue("mail-trigger");
  await name.fill(taken);
  await name.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(`A feature called ${taken} exists already`);
  await expect(line(page, "mail-trigger")).toHaveCount(1);

  // A name with spaces and capitals becomes a slug; the sheet follows it.
  await name.fill("Mail Inbound");
  await name.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(sheet(page)).toHaveAttribute("data-feature", "mail-inbound");
  await expect(sheet(page).getByRole("heading", { name: "mail-inbound" })).toBeVisible();
  await expect(sheet(page).getByTestId("feature-sheet-worker")).toHaveCount(workers);
  await page.keyboard.press("Escape");
  await expect(line(page, "mail-trigger")).toHaveCount(0);
  await expect(line(page, "mail-inbound").getByTestId("rail-worker")).toHaveCount(workers);
  await expect(
    line(page, "mail-inbound").locator(
      `[data-testid="rail-worker"][data-thread-id="${made.working}"]`,
    ),
  ).toBeVisible();
});

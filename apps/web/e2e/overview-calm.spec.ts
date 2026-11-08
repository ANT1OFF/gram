import { expect, test, type Page } from "@playwright/test";

// The overview's calm forms over the realistic morning: workspaces at rest go to At rest, folded,
// every row is one 36 px line, and the compact
// rail tells its workspaces apart by a monogram of each name.

const open = async (page: Page, width: number) => {
  await page.addInitScript(() => sessionStorage.setItem("gram.mock.orchestration", "realistic"));
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/");
  await page.getByTestId("app-shell").waitFor();
  return page.evaluate(async () => (await window.gramMock!.startedRealistic())!);
};

const names = (page: Page, scope: string) =>
  page
    .getByTestId("overview-sidebar")
    .locator(`${scope} [data-testid="overview-workspace"]`)
    .evaluateAll((rows) =>
      rows
        .filter((row) => row.checkVisibility())
        .map((row) => row.querySelector(".truncate.font-medium")?.textContent ?? ""),
    );

test("workspaces at rest go to At rest at the list's end, folded until opened, with the PRs and Done", async ({
  page,
}) => {
  await open(page, 1440);
  const sidebar = page.getByTestId("overview-sidebar");
  const rest = sidebar.getByTestId("overview-section-rest");
  const fold = rest.getByRole("button", { name: /^At rest, \d+$/ });
  // web and infra have nothing running and nothing asking: At rest holds them, folded.
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await expect(
    rest.getByTestId("overview-idle").getByTestId("overview-workspace").first(),
  ).toBeHidden();
  await expect
    .poll(() => names(page, '[data-testid="overview-section-orchestrators"]'))
    .toEqual(["Gram", "billing-api"]);
  // The sections are three at most, every title one look: its count in the right column.
  await expect(
    sidebar.locator("section[data-testid^='overview-section-']:not(section section)"),
  ).toHaveCount(3);
  const counts = await sidebar
    .locator("h2 button")
    .evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.lastElementChild!.getBoundingClientRect().right)),
    );
  expect(new Set(counts).size).toBe(1);
  // Unfolded, the idle workspaces under their heading, kept open across a reload.
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await expect(rest.getByRole("heading", { name: /Idle workspaces/ })).toBeVisible();
  await expect.poll(() => names(page, '[data-testid="overview-idle"]')).toEqual(["web", "infra"]);
  await page.reload();
  await expect(
    sidebar.getByTestId("overview-section-rest").getByRole("button", { name: /^At rest/ }),
  ).toHaveAttribute("aria-expanded", "true");
});

test("every row in the sidebar is one line of one height; a worker's edge keeps its wait's reason", async ({
  page,
}) => {
  await open(page, 1440);
  const sidebar = page.getByTestId("overview-sidebar");
  const workers = sidebar.getByTestId("overview-worker");
  await expect(workers.first()).toBeVisible();
  await sidebar.getByRole("button", { name: /^Solo threads, \d+$/ }).waitFor();
  if ((await sidebar.getByTestId("overview-solo").count()) === 0) {
    await sidebar.getByRole("button", { name: /^Solo threads, \d+$/ }).click();
  }
  const rows = await sidebar
    .locator(
      '[data-testid="overview-worker"], [data-testid="overview-workspace-row"], [data-testid="overview-solo"]',
    )
    .evaluateAll((each) =>
      each
        .filter((row) => row.checkVisibility())
        .map((row) => ({
          tone: row.querySelector("[data-tone]")?.getAttribute("data-tone"),
          height: Math.round(row.getBoundingClientRect().height),
          words: row.querySelector(
            '[data-testid="overview-worker-now"], [data-testid="overview-worker-state"], [data-testid="overview-worker-waiting"]',
          )?.textContent,
        })),
    );
  // Every row is one height, whatever it lists or says.
  expect(rows.length).toBeGreaterThan(4);
  expect(rows.every((row) => row.height === 36)).toBe(true);
  // Working: the dot says it, so no words at the edge.
  expect(rows.filter((row) => row.tone === "working").every((row) => row.words === undefined)).toBe(
    true,
  );
  expect(rows.some((row) => row.words === "Running")).toBe(false);
  // A wait keeps its reason at the edge, without the "Waiting" its hollow dot says.
  const wait = rows.find((row) => row.tone === "waiting");
  expect(wait?.words).toMatch(/^checks/);
});
test("the compact rail marks each workspace with a monogram of its name, the solo threads with a glyph", async ({
  page,
}) => {
  await open(page, 900);
  const rail = page.getByTestId("overview-rail");
  const tiles = rail.locator('[data-testid="overview-tile"][data-workspace-id]');
  await expect(tiles).toHaveCount(4);
  const marks = await tiles.evaluateAll((each) =>
    each.map((tile) => ({
      mark: tile.querySelector('[data-testid="overview-tile-mark"]')?.textContent,
      label: tile.getAttribute("aria-label"),
    })),
  );
  expect(marks.map((tile) => tile.mark)).toEqual(["G", "B", "W", "I"]);
  // The whole name is still its accessible name.
  expect(marks.map((tile) => tile.label?.split(",")[0])).toEqual([
    "Gram",
    "billing-api",
    "web",
    "infra",
  ]);
  await expect(
    rail.locator('[data-tile="solo"] svg'),
    "the solo threads' tile keeps its glyph",
  ).toHaveCount(1);
  // A letter is never left to guess: focus (or a hover) says the whole name at once, in the
  // flyout's head, and the working count stays on the tile.
  await tiles.nth(1).focus();
  await expect(page.getByTestId("overview-flyout").getByRole("heading")).toContainText(
    "billing-api",
    { timeout: 1_000 },
  );
  await expect(tiles.first().getByTestId("overview-tile-count")).toBeVisible();
  // The rail's count is a neutral outline with only its number amber.
  const pill = rail.getByTestId("overview-rail-needs-you");
  await expect(pill).toHaveAttribute("data-asks", "true");
  const fill = await pill.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(fill).toBe("rgba(0, 0, 0, 0)");
});
